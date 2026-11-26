package linkapp

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"agentbox/internal/buildinfo"
)

// Panel is the local control console: a small HTTP server on the loopback
// interface that lets the user pair, choose folders, and manage the connection
// without touching a terminal.
type Panel struct {
	sup *Supervisor

	mu        sync.Mutex // guards cfg, which the handlers read-modify-write
	actions   sync.Mutex // serializes configuration changes with connection restarts
	cfg       Config
	transfers chan struct{}
	picker    chan struct{}
}

// NewPanel returns a panel over cfg and sup.
func NewPanel(cfg Config, sup *Supervisor) *Panel {
	return &Panel{cfg: cfg, sup: sup, transfers: make(chan struct{}, 2), picker: make(chan struct{}, 1)}
}

// Config returns a copy of the current config.
func (p *Panel) Config() Config {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cfg
}

// Handler builds the panel's routes.
func (p *Panel) Handler() http.Handler {
	mux := http.NewServeMux()

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err) // embedded at build time; a failure here is a build bug
	}
	mux.Handle("GET /", http.FileServer(http.FS(sub)))

	mux.HandleFunc("GET /api/state", p.handleState)
	mux.HandleFunc("GET /api/logs", p.handleLogs)
	mux.HandleFunc("POST /api/pair", p.handlePair)
	mux.HandleFunc("POST /api/unpair", p.handleUnpair)
	mux.HandleFunc("POST /api/config", p.handleConfig)
	mux.HandleFunc("POST /api/folders", p.handleFolders)
	mux.HandleFunc("GET /api/file-manager/local", p.managerLocal)
	mux.HandleFunc("GET /api/file-manager/workspaces", p.managerRemote)
	mux.HandleFunc("GET /api/file-manager/remote", p.managerRemote)
	mux.HandleFunc("POST /api/file-manager/action", p.managerRemoteAction)
	mux.HandleFunc("POST /api/file-manager/transfer", p.managerTransfer)
	mux.HandleFunc("POST /api/file-manager/pick-folder", p.managerPickFolder)
	mux.HandleFunc("POST /api/start", p.handleStart)
	mux.HandleFunc("POST /api/stop", p.handleStop)
	mux.HandleFunc("POST /api/autostart", p.handleAutostart)

	return localGuard(mux)
}

// localGuard keeps the panel reachable only from this machine's own browser.
// Binding to loopback stops the network; this stops the two attacks that get
// past a loopback bind:
//
//   - DNS rebinding — a hostile name resolved to 127.0.0.1 — blocked by
//     requiring the Host header to be a loopback literal.
//   - Silent cross-origin POSTs from any page the user has open — blocked by
//     requiring a custom header, which forces a CORS preflight that we never
//     answer, and by rejecting foreign Origins outright.
func localGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
		if ip := net.ParseIP(strings.Trim(host, "[]")); !(ip != nil && ip.IsLoopback()) && host != "localhost" {
			http.Error(w, "abox-link 控制台只能从本机访问", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isLoopbackOrigin(origin) {
			http.Error(w, "跨站请求被拒绝", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("X-Abox-Panel") != "1" {
			http.Error(w, "缺少 X-Abox-Panel 头", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// --- handlers ---

func (p *Panel) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, p.state())
}

// state is the whole panel view in one object — the UI re-renders from it on
// every poll, so there is exactly one shape to keep in sync.
func (p *Panel) state() map[string]any {
	cfg := p.Config()
	return map[string]any{
		"version": buildinfo.Version,
		"paired":  cfg.Paired(),

		"server":   cfg.Server,
		"user":     cfg.User,
		"insecure": cfg.Insecure,

		"folders":      cfg.Folders,
		"auto_connect": cfg.AutoConnect,
		"running":      p.sup.Running(),
		"status":       p.sup.Status(),
		"autostart":    AutostartStatus(),
	}
}

func (p *Panel) handleLogs(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	lines, latest := p.sup.Logs(since)
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "latest": latest})
}

func (p *Panel) handlePair(w http.ResponseWriter, r *http.Request) {
	p.actions.Lock()
	defer p.actions.Unlock()
	var req struct {
		Code     string `json:"code"`
		Insecure bool   `json:"insecure"`
	}
	if !decodeBody(w, r, &req) {
		return
	}

	cfg, err := Pair(p.Config(), req.Code, req.Insecure)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := SaveConfig(cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存配置失败："+err.Error())
		return
	}
	// The connection uses the credentials and folders it started with.
	p.sup.Stop()
	p.mu.Lock()
	p.cfg = cfg
	p.mu.Unlock()

	p.sup.Logf("已接入 %s，账号 %s", cfg.Server, cfg.User)
	writeJSON(w, http.StatusOK, p.state())
}

func (p *Panel) handleUnpair(w http.ResponseWriter, r *http.Request) {
	p.actions.Lock()
	defer p.actions.Unlock()
	p.sup.Stop()

	// Best-effort: revoke the session token on the server so a leaked or copied
	// config.json can't keep using it after the user unpairs. Failure is
	// non-fatal — proceed to clear local state either way.
	old := p.Config()
	if old.Server != "" && old.Token != "" {
		if err := RevokeToken(old.Server, old.Token, old.Insecure); err != nil {
			p.sup.Logf("解绑：服务端令牌吊销失败（%v），本地凭证仍会清除", err)
		} else {
			p.sup.Logf("解绑：已通知服务端吊销令牌")
		}
	}

	p.mu.Lock()
	cfg := p.cfg
	cfg.Server, cfg.User, cfg.Token = "", "", ""
	cfg.Folders = nil
	if err := SaveConfig(cfg); err != nil {
		p.mu.Unlock()
		writeErr(w, http.StatusInternalServerError, "保存配置失败："+err.Error())
		return
	}
	p.cfg = cfg
	p.mu.Unlock()

	p.sup.Logf("已解除设备配对")
	writeJSON(w, http.StatusOK, p.state())
}

func (p *Panel) handleConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AutoConnect *bool `json:"auto_connect"`
		Insecure    *bool `json:"insecure"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	p.actions.Lock()
	defer p.actions.Unlock()
	cfg := p.Config()
	reconnect := req.Insecure != nil && *req.Insecure != cfg.Insecure && p.sup.Running()
	if req.AutoConnect != nil {
		cfg.AutoConnect = *req.AutoConnect
	}
	if req.Insecure != nil {
		cfg.Insecure = *req.Insecure
	}
	if err := SaveConfig(cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存配置失败："+err.Error())
		return
	}
	p.mu.Lock()
	p.cfg = cfg
	p.mu.Unlock()
	if reconnect {
		p.sup.Stop()
		if err := p.sup.Start(cfg); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, p.state())
}

func (p *Panel) handleStart(w http.ResponseWriter, r *http.Request) {
	p.actions.Lock()
	defer p.actions.Unlock()
	if err := p.sup.Start(p.Config()); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p.state())
}

func (p *Panel) handleStop(w http.ResponseWriter, r *http.Request) {
	p.actions.Lock()
	defer p.actions.Unlock()
	p.sup.Stop()
	writeJSON(w, http.StatusOK, p.state())
}

func (p *Panel) handleAutostart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enable bool `json:"enable"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	var err error
	if req.Enable {
		err = InstallAutostart()
	} else {
		err = UninstallAutostart()
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p.state())
}

// --- small helpers ---

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
