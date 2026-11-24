package dockerx

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

//go:embed browser-seccomp.json
var browserSeccomp string

// BrowserInfo never exposes the internal proxy credential or network hash.
type BrowserInfo struct {
	Available  bool   `json:"available"`
	Running    bool   `json:"running"`
	Browser    string `json:"browser,omitempty"`
	Proxy      bool   `json:"proxy"`
	Navigation bool   `json:"navigation,omitempty"`
	NetworkKey string `json:"-"`
}

func (m *Manager) BrowserCommand(ctx context.Context, id, action, url string, env []string) (BrowserInfo, error) {
	info, err := m.cli.ContainerInspect(ctx, id)
	if err != nil {
		return BrowserInfo{}, err
	}
	available := info.Config != nil && info.Config.Labels["agentbox.browser"] == "1"
	if !available {
		return BrowserInfo{}, nil
	}
	payload, _ := json.Marshal(map[string]string{"url": url})
	out, err := m.ExecCapture(ctx, id, []string{"python3", "-I", "/opt/agentbox/browser.py", action}, env, string(payload))
	if err != nil {
		return BrowserInfo{}, fmt.Errorf("浏览器操作失败，请检查镜像、内存和 Chrome 沙箱支持: %w", err)
	}
	var result struct {
		Running    bool   `json:"running"`
		Browser    string `json:"browser"`
		Proxy      bool   `json:"proxy"`
		Navigation bool   `json:"navigation"`
		NetworkKey string `json:"network_key"`
		Error      string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return BrowserInfo{}, errors.New("浏览器返回无效状态")
	}
	if result.Error != "" {
		return BrowserInfo{}, browserHelperError(result.Error, "浏览器操作失败")
	}
	return BrowserInfo{Available: true, Running: result.Running, Browser: result.Browser, Proxy: result.Proxy, Navigation: result.Navigation, NetworkKey: result.NetworkKey}, nil
}

type BrowserNavigationRequest struct {
	Operation string `json:"operation"`
	URL       string `json:"url,omitempty"`
	Tab       string `json:"tab,omitempty"`
	Enabled   bool   `json:"enabled"`
}

type BrowserTab struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type BrowserNavigation struct {
	Active     string       `json:"active"`
	Tabs       []BrowserTab `json:"tabs"`
	Back       bool         `json:"back"`
	Forward    bool         `json:"forward"`
	Fullscreen bool         `json:"fullscreen"`
}

func (m *Manager) BrowserNavigation(ctx context.Context, id string, req BrowserNavigationRequest) (BrowserNavigation, error) {
	payload, _ := json.Marshal(req)
	out, err := m.ExecCapture(ctx, id, []string{"python3", "-I", "/opt/agentbox/browser.py", "navigation"}, nil, string(payload))
	if err != nil {
		return BrowserNavigation{}, errors.New("浏览器操作失败")
	}
	var result struct {
		BrowserNavigation
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil || result.Error != "" || result.Tabs == nil {
		return BrowserNavigation{}, errors.New("浏览器操作失败")
	}
	return result.BrowserNavigation, nil
}

func browserContainerOptions(cc *container.Config, hc *container.HostConfig, labels map[string]string) {
	if labels["agentbox.browser"] != "1" {
		return
	}
	cc.Labels["agentbox.browser"] = "1"
	// Docker's default seccomp denies the user namespaces required by Chrome's
	// sandbox. Preserve all other default restrictions; never use --no-sandbox.
	var compact json.RawMessage = json.RawMessage(browserSeccomp)
	raw, _ := json.Marshal(compact)
	hc.SecurityOpt = append(hc.SecurityOpt, "seccomp="+string(raw))
	hc.ShmSize = 256 << 20
}

func (m *Manager) BrowserClipboard(ctx context.Context, id string, write bool, text string) (string, error) {
	payload, _ := json.Marshal(map[string]any{"write": write, "text": text})
	out, err := m.ExecCapture(ctx, id, []string{"python3", "-I", "/opt/agentbox/browser.py", "clipboard"}, nil, string(payload))
	if err != nil {
		return "", err
	}
	var result struct {
		Text  string `json:"text"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return "", err
	}
	if result.Error != "" {
		return "", browserHelperError(result.Error, "剪贴板操作失败")
	}
	return result.Text, nil
}

// Only forward fixed messages authored by the bundled browser helper. Arbitrary
// container diagnostics may contain private paths, configuration, or credentials.
func browserHelperError(message, fallback string) error {
	switch message {
	case "地址格式无效", "仅支持不含用户名密码的 HTTP / HTTPS 地址",
		"显示服务启动超时", "显示服务启动失败", "浏览器代理配置无效",
		"浏览器启动失败，请检查镜像及用户命名空间沙箱支持", "远程桌面启动超时",
		"剪贴板内容过长", "打开网页失败", "未知操作", "浏览器未运行",
		"浏览器尚未完全停止，请稍后重试", "浏览器网络切换超时，请停止工作空间后重试", "浏览器启动超时":
		return errors.New(message)
	default:
		return errors.New(fallback)
	}
}

// Flush browser state before stopping/removing the workspace. Docker's stop
// signal targets PID 1 (sleep/tini), not Chrome's window manager, so it cannot
// by itself guarantee that the browser persists its most recent cookies.
func (m *Manager) closeBrowser(ctx context.Context, id string) error {
	info, err := m.cli.ContainerInspect(ctx, id)
	if client.IsErrNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.State == nil || !info.State.Running || info.Config == nil || info.Config.Labels["agentbox.browser"] != "1" {
		return nil
	}
	_, err = m.BrowserCommand(ctx, id, "stop", "", nil)
	return err
}
