package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVoiceTranscriptionRequestsRussian(t *testing.T) {
	whisper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/inference" {
			t.Errorf("unexpected inference request: %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("parse inference form: %v", err)
			http.Error(w, "invalid inference form", http.StatusBadRequest)
			return
		}
		if got := r.FormValue("language"); got != "ru" {
			t.Errorf("inference language = %q, want ru", got)
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": "Проверка"})
	}))
	defer whisper.Close()

	_, port, err := net.SplitHostPort(whisper.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTBOX_WHISPER_PORT", port)
	request := httptest.NewRequest(http.MethodPost, "/api/voice", strings.NewReader("\x00\x00"))
	request.Header.Set("Content-Type", "application/octet-stream")
	response := httptest.NewRecorder()
	(&Server{}).handleVoiceTranscription(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Проверка") {
		t.Fatalf("voice response: %d %s", response.Code, response.Body)
	}
}
