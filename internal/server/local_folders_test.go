package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentbox/internal/config"
	"agentbox/internal/devicelink"
	"agentbox/internal/store"
	"github.com/hashicorp/yamux"
)

func TestLocalFolderBrowserAndImport(t *testing.T) {
	s, workspace := newTestServer(t)
	user := store.User{Name: workspace.User, Role: store.RoleUser, CreatedAt: time.Now().UTC()}
	if err := s.store.CreateUser(user); err != nil {
		t.Fatal(err)
	}
	if err := s.store.Put(workspace); err != nil {
		t.Fatal(err)
	}
	const token = "local-test-token"
	if err := s.store.CreateToken(token, user.Name); err != nil {
		t.Fatal(err)
	}
	const folderID = "test-folder-00001"
	shares := []devicelink.Folder{{ID: folderID, Name: "Exchange"}}
	for i := 1; i < devicelink.MaxFolders; i++ {
		shares = append(shares, devicelink.Folder{ID: fmt.Sprintf("test-folder-extra-%02d", i), Name: strings.Repeat("&", 128)})
	}
	if err := s.saveLinkFolders(user, shares); err != nil {
		t.Fatal(err)
	}
	s.devices = newDeviceHub()
	s.cfg.DeviceLink = config.DeviceLinkConfig{Enabled: true}
	left, right := net.Pipe()
	server, _ := yamux.Client(left, nil)
	link, _ := yamux.Server(right, nil)
	defer link.Close()
	unregister := s.devices.register(user.Name, server, deviceInfo{folders: shares, token: token})
	defer unregister()
	go devicelink.Serve(link, func(stream io.ReadWriter) {
		var req devicelink.FolderRequest
		if devicelink.ReadFolderMessage(stream, &req) != nil {
			return
		}
		if !req.Read {
			devicelink.WriteFolderMessage(stream, devicelink.FolderResponse{Entries: []devicelink.FolderEntry{{Name: "report.txt", Size: 6}}})
			return
		}
		devicelink.WriteFolderMessage(stream, devicelink.FolderResponse{Size: 6})
		if req.Path == "cut.txt" {
			io.WriteString(stream, "cut")
		} else {
			io.WriteString(stream, "report")
		}
	})
	request := func(method, address, body string, owner store.User) *http.Request {
		req := httptest.NewRequest(method, address, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-AgentBox-Local-Files", "1")
		req.SetPathValue("folder", folderID)
		return req.WithContext(context.WithValue(req.Context(), ctxUser, owner))
	}
	w := httptest.NewRecorder()
	s.handleLocalFolder(w, request(http.MethodGet, "/api/local-folders/test", "", user))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "report.txt") {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	s.handleLocalFolder(w, request(http.MethodGet, "/api/local-folders/test", "", store.User{Name: "other"}))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("cross-user list: %d %s", w.Code, w.Body.String())
	}
	importFile := func(name string, attachment bool) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"folder": folderID, "path": name, "attachment": attachment})
		s.handleLocalFile(w, request(http.MethodPost, "/local-file", string(body), user), workspace)
		return w
	}
	if w := importFile("report.txt", false); w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(s.workspaceDir(workspace), "report.txt"))
	if err != nil || string(data) != "report" {
		t.Fatalf("stored file: %q, %v", data, err)
	}
	if w := importFile("report.txt", false); w.Code != http.StatusConflict {
		t.Fatalf("overwriting import: %d %s", w.Code, w.Body.String())
	}
	if w := importFile("cut.txt", false); w.Code == http.StatusOK {
		t.Fatal("truncated transfer was accepted")
	}
	if _, err := os.Stat(filepath.Join(s.workspaceDir(workspace), "cut.txt")); !os.IsNotExist(err) {
		t.Fatalf("truncated file exposed: %v", err)
	}
	if w := importFile("report.txt", true); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "/shared/.file/") {
		t.Fatalf("attachment: %d %s", w.Code, w.Body.String())
	}
	server.Close()
	w = httptest.NewRecorder()
	s.handleLocalFolders(w, request(http.MethodGet, "/api/local-folders", "", user))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"online":false`) || !strings.Contains(w.Body.String(), "Exchange") {
		t.Fatalf("offline catalog: %d %s", w.Code, w.Body.String())
	}
}
