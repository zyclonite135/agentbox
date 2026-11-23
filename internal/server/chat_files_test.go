package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"agentbox/internal/store"
)

func TestChatFilesArchiveSelectedPaths(t *testing.T) {
	s, sess := newTestServer(t)
	if err := s.store.Put(sess); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{sess.User, "bob"} {
		if err := s.store.CreateUser(store.User{Name: user, Role: store.RoleUser}); err != nil {
			t.Fatal(err)
		}
		if err := s.store.CreateToken(user, user); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"website/index.html":       "<link rel=stylesheet href=css/main.css>",
		"website/css/main.css":     "body { color: black; }",
		"website/pages/about.html": "<img src=../img/logo.svg>",
		"website/img/logo.svg":     "<svg></svg>",
		"website/js/main.js":       "console.log('ready');",
		"scratch.txt":              "not selected",
	}
	paths := make([]string, 0, 5)
	for name, content := range files {
		path := filepath.Join(s.workspaceDir(sess), name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if name != "scratch.txt" {
			paths = append(paths, name)
		}
	}
	handler := s.Handler()
	request := func(token string, paths []string) *httptest.ResponseRecorder {
		data, err := json.Marshal(map[string][]string{"paths": paths})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sess.ID+"/chat/files/archive", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	w := request(sess.User, paths)
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	z, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil || len(z.File) != len(paths) {
		t.Fatalf("invalid ZIP: %v", err)
	}
	for _, f := range z.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil || f.Name == "scratch.txt" || string(body) != files[f.Name] {
			t.Fatalf("unexpected ZIP entry %q: %s (%v)", f.Name, body, err)
		}
	}
	if w := request("bob", paths); w.Code != http.StatusNotFound {
		t.Fatalf("foreign workspace: %d", w.Code)
	}
	if err := os.Symlink("scratch.txt", filepath.Join(s.workspaceDir(sess), "link.txt")); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int{
		"../escape": http.StatusBadRequest, ".git/config": http.StatusBadRequest,
		"missing.txt": http.StatusNotFound, "link.txt": http.StatusNotFound,
		paths[0]: http.StatusBadRequest,
	} {
		files := append(append([]string{}, paths...), path)
		if w := request(sess.User, files); w.Code != want || w.Header().Get("Content-Type") == "application/zip" {
			t.Errorf("path %q: status %d, want %d", path, w.Code, want)
		}
	}
}
