package linkapp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFolderPickerSharesFolderWithLongName(t *testing.T) {
	t.Setenv("ABOX_LINK_HOME", t.TempDir())
	p := NewPanel(Config{Server: "http://127.0.0.1:8080", User: "first", Token: "token"}, NewSupervisor())
	folder := filepath.Join(t.TempDir(), strings.Repeat("п", 65))
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	p.pickFolder = func() (string, error) { return folder, nil }

	picked := httptest.NewRecorder()
	p.managerPickFolder(picked, httptest.NewRequest(http.MethodPost, "/api/file-manager/pick-folder", nil))
	if picked.Code != http.StatusOK {
		t.Fatalf("pick folder returned %d: %s", picked.Code, picked.Body)
	}
	var selection struct{ Name, Path string }
	if err := json.Unmarshal(picked.Body.Bytes(), &selection); err != nil {
		t.Fatal(err)
	}
	if want := strings.Repeat("п", 62) + "…"; selection.Name != want || selection.Path != folder {
		t.Fatalf("picker returned %+v, want name %q and path %q", selection, want, folder)
	}

	shared := httptest.NewRecorder()
	p.handleFolders(shared, httptest.NewRequest(http.MethodPost, "/api/folders", bytes.NewReader(picked.Body.Bytes())))
	if shared.Code != http.StatusOK {
		t.Fatalf("share folder returned %d: %s", shared.Code, shared.Body)
	}
	resolved, err := filepath.EvalSymlinks(folder)
	if err != nil {
		t.Fatal(err)
	}
	if folders := p.Config().Folders; len(folders) != 1 || folders[0].Name != selection.Name || folders[0].Path != resolved {
		t.Fatalf("unexpected shared folders: %+v", folders)
	}
}

func TestFolderPickerDiscardsSelectionAfterPairingChanges(t *testing.T) {
	p := NewPanel(Config{Server: "http://127.0.0.1:8080", User: "first", Token: "token"}, NewSupervisor())
	folder := t.TempDir()
	p.pickFolder = func() (string, error) {
		p.mu.Lock()
		p.cfg.User = "second"
		p.mu.Unlock()
		return folder, nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/file-manager/pick-folder", nil)
	p.managerPickFolder(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("picker returned status %d after pairing changed, want %d", rec.Code, http.StatusConflict)
	}
}
