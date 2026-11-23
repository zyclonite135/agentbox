package server

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"agentbox/internal/store"
)

func TestChatImageReadScope(t *testing.T) {
	s, sess := newTestServer(t)
	if err := s.store.Put(sess); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{sess.User, "bob"} {
		if err := s.store.CreateUser(store.User{Name: name, Role: store.RoleUser}); err != nil {
			t.Fatal(err)
		}
		if err := s.store.CreateToken(name, name); err != nil {
			t.Fatal(err)
		}
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(s.homeDir(sess), ".codex", "generated_images")
	if err := os.MkdirAll(filepath.Join(root, "turn"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "..", "outside.png")
	for path, data := range map[string][]byte{
		filepath.Join(root, "turn", "image.png"): pngData.Bytes(),
		filepath.Join(root, "fake.png"):          []byte("<html><script></script></html>"),
		outside:                                  pngData.Bytes(),
	} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "link.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "linked-dir")); err != nil {
		t.Fatal(err)
	}

	handler := s.Handler()
	request := func(token, path string) *httptest.ResponseRecorder {
		query := url.Values{"path": {path}, "token": {token}}
		r := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sess.ID+"/chat/image?"+query.Encode(), nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	ok := request(sess.User, "turn/image.png")
	if ok.Code != http.StatusOK || ok.Header().Get("Content-Type") != "image/png" ||
		ok.Header().Get("X-Content-Type-Options") != "nosniff" || !bytes.Equal(ok.Body.Bytes(), pngData.Bytes()) {
		t.Fatalf("image response: status %d, headers %v, body %q", ok.Code, ok.Header(), ok.Body.Bytes())
	}
	for _, token := range []string{"", "bob"} {
		if w := request(token, "turn/image.png"); w.Code < 400 {
			t.Fatalf("image available to %q: status %d", token, w.Code)
		}
	}
	for _, path := range []string{"../outside.png", "link.png", "linked-dir/outside.png", "gone.png"} {
		if w := request(sess.User, path); w.Code != http.StatusNotFound {
			t.Errorf("path %q: status %d, want 404", path, w.Code)
		}
	}
	if w := request(sess.User, "fake.png"); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("fake image: status %d, want 415", w.Code)
	}
}
