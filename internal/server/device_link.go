package server

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"agentbox/internal/devicelink"
	"agentbox/internal/store"
	"github.com/hashicorp/yamux"
)

type deviceHub struct {
	connectMu sync.Mutex
	mu        sync.RWMutex
	conns     map[string]*yamux.Session
	info      map[string]deviceInfo
}

type deviceInfo struct {
	folders []devicelink.Folder
	token   string
}

func newDeviceHub() *deviceHub {
	return &deviceHub{conns: map[string]*yamux.Session{}, info: map[string]deviceInfo{}}
}

func (h *deviceHub) register(user string, sess *yamux.Session, info deviceInfo) func() {
	h.mu.Lock()
	old := h.conns[user]
	h.conns[user], h.info[user] = sess, info
	h.mu.Unlock()
	if old != nil && old != sess {
		_ = old.Close()
	}
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.conns[user] == sess {
			delete(h.conns, user)
			delete(h.info, user)
		}
	}
}

func (h *deviceHub) closeAll() {
	h.connectMu.Lock()
	defer h.connectMu.Unlock()
	h.mu.Lock()
	sessions := h.conns
	h.conns, h.info = map[string]*yamux.Session{}, map[string]deviceInfo{}
	h.mu.Unlock()
	for _, sess := range sessions {
		_ = sess.Close()
	}
}

func (s *Server) handleDeviceLinkWS(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.GetDeviceLink().Enabled {
		writeErr(w, http.StatusForbidden, "设备连接已停用")
		return
	}
	user := reqUser(r)
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		writeErr(w, http.StatusUnauthorized, "device credentials required")
		return
	}
	folders, err := parseLinkFolders(r.Header.Get(devicelink.FoldersHeader))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid folder catalog")
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	release, ok := s.track(func() { _ = conn.Close() })
	if !ok {
		return
	}
	defer release()
	cfg := yamux.DefaultConfig()
	cfg.KeepAliveInterval = 15 * time.Second
	cfg.ConnectionWriteTimeout = 15 * time.Second
	sess, err := yamux.Client(devicelink.NewWSConn(conn), cfg)
	if err != nil {
		return
	}
	defer sess.Close()

	s.devices.connectMu.Lock()
	owner, valid := s.store.TokenUser(token)
	if !valid || owner.Name != user.Name || !owner.CreatedAt.Equal(user.CreatedAt) ||
		!s.cfg.GetDeviceLink().Enabled || sess.IsClosed() {
		s.devices.connectMu.Unlock()
		return
	}
	if err := s.saveLinkFolders(user, token, folders); err != nil {
		s.devices.connectMu.Unlock()
		log.Printf("save device folders for %q: %v", user.Name, err)
		return
	}
	unregister := s.devices.register(user.Name, sess, deviceInfo{folders: folders, token: token})
	s.devices.connectMu.Unlock()
	defer unregister()
	<-sess.CloseChan()
}

func (s *Server) handleDeviceLinkStatus(w http.ResponseWriter, r *http.Request) {
	user := reqUser(r)
	enabled := s.cfg.GetDeviceLink().Enabled
	sess, _ := s.liveLinkFolders(user)
	view := map[string]any{"enabled": enabled, "connected": enabled && sess != nil}
	if user.Role == store.RoleAdmin {
		online := []string{}
		if enabled {
			s.devices.mu.RLock()
			for name, conn := range s.devices.conns {
				if conn.IsClosed() {
					continue
				}
				if owner, ok := s.store.TokenUser(s.devices.info[name].token); ok && owner.Name == name {
					online = append(online, name)
				}
			}
			s.devices.mu.RUnlock()
		}
		sort.Strings(online)
		view["online_users"] = online
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) clientDir() string { return filepath.Join(s.cfg.DataDir, "abox-link") }

func (s *Server) handleDeviceLinkClients(w http.ResponseWriter, r *http.Request) {
	ents, err := os.ReadDir(s.clientDir())
	out := []map[string]any{}
	if err == nil {
		for _, e := range ents {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, map[string]any{"name": e.Name(), "size": fi.Size()})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeviceLinkClientGet(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	// The name must be a plain file name inside the client dir — no traversal.
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		writeErr(w, http.StatusBadRequest, "invalid client name")
		return
	}
	path := filepath.Join(s.clientDir(), name)
	if fi, err := os.Stat(path); err != nil || fi.IsDir() {
		writeErr(w, http.StatusNotFound, "client binary not found")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, path)
}
