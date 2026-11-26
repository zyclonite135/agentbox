package linkapp

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func (p *Panel) managerPickFolder(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	cfg, pick := p.cfg, p.pickFolder
	p.mu.Unlock()
	if !cfg.Paired() {
		writeErr(w, http.StatusConflict, "请先接入服务器")
		return
	}
	select {
	case p.picker <- struct{}{}:
		defer func() { <-p.picker }()
	default:
		writeErr(w, http.StatusTooManyRequests, "文件操作忙，请稍后重试")
		return
	}
	var value string
	var err error
	if pick != nil {
		value, err = pick()
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		value, err = pickSystemFolder(ctx)
	}
	if r.Context().Err() != nil {
		return
	}
	current := p.Config()
	if current.Token != cfg.Token || current.Server != cfg.Server || current.User != cfg.User {
		writeErr(w, http.StatusConflict, "凭证已失效")
		return
	}
	if err != nil || value != "" && !filepath.IsAbs(value) {
		writeErr(w, http.StatusServiceUnavailable, "无法打开系统文件夹选择器，请输入路径")
		return
	}
	if value != "" {
		value = filepath.Clean(value)
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": value, "name": filepath.Base(value)})
}

func pickSystemFolder(ctx context.Context) (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command",
			"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath)) }")
	case "darwin":
		cmd = exec.CommandContext(ctx, "osascript", "-e", "try", "-e", "return POSIX path of (choose folder)", "-e", "on error number -128", "-e", "return \"\"", "-e", "end try")
	default:
		cmd = exec.CommandContext(ctx, "zenity", "--file-selection", "--directory")
	}
	hideCommandWindow(cmd)
	out, err := cmd.Output()
	var exit *exec.ExitError
	if runtime.GOOS == "linux" && errors.As(err, &exit) && exit.ExitCode() == 1 && len(exit.Stderr) == 0 {
		err = nil
	}
	value := strings.TrimRight(string(out), "\r\n")
	if err == nil && runtime.GOOS == "windows" && value != "" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		value, err = string(decoded), decodeErr
	}
	return value, err
}
