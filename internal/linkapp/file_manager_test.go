package linkapp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentbox/internal/devicelink"
)

func TestFileManagerCopiesBothDirections(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "source.zip"), []byte("ZIP bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	sent := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "PUT /api/sessions/workspace/files/copy":
			if r.URL.Query().Get("path") != "documents/source.zip" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			content, err := io.ReadAll(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			sent <- string(content)
			w.WriteHeader(http.StatusOK)
		case "GET /api/sessions/workspace/file":
			if r.URL.Query().Get("path") == "broken.zip" {
				w.Header().Set("Content-Length", "20")
			}
			io.WriteString(w, "result")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	folder := localFolder{Folder: devicelink.Folder{ID: "fixture-folder-1234", Name: "Files"}, Path: dir}
	p := NewPanel(Config{Server: upstream.URL, User: "user", Token: "fixture-token", Folders: []localFolder{folder}}, NewSupervisor())
	copyFile := func(direction, source, dest string, replace bool) *httptest.ResponseRecorder {
		body, err := json.Marshal(managerCopy{Workspace: "workspace", Folder: folder.ID, Direction: direction, Source: source, Destination: dest, Replace: replace})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/file-manager/transfer", strings.NewReader(string(body)))
		req.Header.Set("X-Abox-Panel", "1")
		recorder := httptest.NewRecorder()
		p.Handler().ServeHTTP(recorder, req)
		return recorder
	}
	done := func(w *httptest.ResponseRecorder) bool {
		return w.Code == http.StatusOK && strings.Contains(w.Body.String(), "\"done\":true")
	}
	if w := copyFile("upload", "source.zip", "documents/source.zip", false); !done(w) {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	if content := <-sent; content != "ZIP bytes" {
		t.Fatalf("upstream received %q", content)
	}
	if w := copyFile("download", "result.zip", "result.zip", false); !done(w) {
		t.Fatalf("download: %d %s", w.Code, w.Body)
	}
	if content, _ := os.ReadFile(filepath.Join(dir, "result.zip")); string(content) != "result" {
		t.Fatalf("saved content: %q", content)
	}
	if w := copyFile("download", "result.zip", "source.zip", false); !strings.Contains(w.Body.String(), "\"conflict\":true") {
		t.Fatal("an existing file was not reported as a conflict")
	}
	if w := copyFile("download", "broken.zip", "source.zip", true); done(w) {
		t.Fatal("truncated download succeeded")
	}
	if content, _ := os.ReadFile(filepath.Join(dir, "source.zip")); string(content) != "ZIP bytes" {
		t.Fatalf("failed transfer changed the original: %q", content)
	}
	if w := copyFile("download", "result.zip", "../outside.zip", false); w.Code != http.StatusBadRequest {
		t.Fatal("relative escape was accepted")
	}
}
