package linkapp

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

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
