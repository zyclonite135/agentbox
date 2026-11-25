package server

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
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
	request := func(token, path string, download bool) *httptest.ResponseRecorder {
		query := url.Values{"path": {path}, "token": {token}}
		if download {
			query.Set("dl", "1")
		}
		r := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sess.ID+"/chat/image?"+query.Encode(), nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	ok := request(sess.User, "turn/image.png", false)
	if ok.Code != http.StatusOK || ok.Header().Get("Content-Type") != "image/png" ||
		ok.Header().Get("X-Content-Type-Options") != "nosniff" || !bytes.Equal(ok.Body.Bytes(), pngData.Bytes()) {
		t.Fatalf("image response: status %d, headers %v, body %q", ok.Code, ok.Header(), ok.Body.Bytes())
	}
	download := request(sess.User, "turn/image.png", true)
	if download.Code != http.StatusOK || download.Header().Get("Content-Disposition") != "attachment; filename=image.png" ||
		!bytes.Equal(download.Body.Bytes(), pngData.Bytes()) {
		t.Fatalf("download response: status %d, headers %v", download.Code, download.Header())
	}
	for _, token := range []string{"", "bob"} {
		if w := request(token, "turn/image.png", false); w.Code < 400 {
			t.Fatalf("image available to %q: status %d", token, w.Code)
		}
	}
	for _, path := range []string{"../outside.png", "link.png", "linked-dir/outside.png", "gone.png"} {
		if w := request(sess.User, path, false); w.Code != http.StatusNotFound {
			t.Errorf("path %q: status %d, want 404", path, w.Code)
		}
	}
	if w := request(sess.User, "fake.png", false); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("fake image: status %d, want 415", w.Code)
	}
}

func TestChatImageThumbnail(t *testing.T) {
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
	dir := filepath.Join(s.homeDir(sess), ".codex", "generated_images")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	makeSource := func(fill color.Color) []byte {
		t.Helper()
		im := image.NewNRGBA(image.Rect(0, 0, 1440, 800))
		draw.Draw(im, im.Bounds(), image.NewUniform(fill), image.Point{}, draw.Src)
		var raw bytes.Buffer
		encoder := png.Encoder{CompressionLevel: png.NoCompression}
		if err := encoder.Encode(&raw, im); err != nil {
			t.Fatal(err)
		}
		return raw.Bytes()
	}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	original := makeSource(color.NRGBA{R: 200, G: 40, A: 255})
	write("image.png", original)
	handler := s.Handler()
	request := func(path, token, options, etag string) *httptest.ResponseRecorder {
		t.Helper()
		query := url.Values{"path": {path}, "token": {token}}
		r := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sess.ID+"/chat/image?"+query.Encode()+options, nil)
		r.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}

	preview := request("image.png", sess.User, "&thumb=1", "")
	if preview.Code != http.StatusOK || preview.Header().Get("Content-Type") != "image/jpeg" ||
		preview.Header().Get("Cache-Control") != "private, no-cache" || preview.Body.Len() >= len(original) {
		t.Fatalf("thumbnail status %d, headers %v, size %d (original %d)", preview.Code, preview.Header(), preview.Body.Len(), len(original))
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(preview.Body.Bytes()))
	if err != nil || cfg.Width != 720 || cfg.Height != 400 {
		t.Fatalf("thumbnail dimensions %dx%d, err %v", cfg.Width, cfg.Height, err)
	}
	tag := preview.Header().Get("ETag")
	revalidated := request("image.png", sess.User, "&thumb=1", tag)
	if tag == "" || revalidated.Code != http.StatusNotModified || revalidated.Body.Len() != 0 {
		t.Fatalf("thumbnail was not revalidated: tag %q, status %d, bytes %d", tag, revalidated.Code, revalidated.Body.Len())
	}
	if w := request("image.png", "bob", "&thumb=1", tag); w.Code < 400 || w.Header().Get("ETag") != "" {
		t.Fatalf("another user can access a cached thumbnail: %d", w.Code)
	}

	for _, options := range []string{"", "&dl=1", "&dl=1&thumb=1"} {
		w := request("image.png", sess.User, options, tag)
		if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), original) ||
			w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("original bytes changed for %q: status %d, headers %v", options, w.Code, w.Header())
		}
		if options != "" && w.Header().Get("Content-Disposition") != "attachment; filename=image.png" {
			t.Fatalf("download filename changed for %q: %v", options, w.Header())
		}
	}

	// Replacing a file at the same path must invalidate the cached preview,
	// even when the new file inherits the original modification time.
	file := filepath.Join(dir, "image.png")
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	write("replacement.png", makeSource(color.NRGBA{B: 220, A: 255}))
	replacement := filepath.Join(dir, "replacement.png")
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, file); err != nil {
		t.Fatal(err)
	}
	changed := request("image.png", sess.User, "&thumb=1", tag)
	if changed.Code != http.StatusOK || changed.Header().Get("ETag") == tag || bytes.Equal(changed.Body.Bytes(), preview.Body.Bytes()) {
		t.Fatalf("thumbnail did not change after replacement: %d, %q", changed.Code, changed.Header().Get("ETag"))
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if gone := request("image.png", sess.User, "&thumb=1", changed.Header().Get("ETag")); gone.Code != http.StatusNotFound {
		t.Fatalf("deleted image still accessible: %d", gone.Code)
	}

	write("alpha.png", makeSource(color.NRGBA{R: 200, A: 128}))
	alpha := request("alpha.png", sess.User, "&thumb=1", "")
	transparent, err := png.Decode(bytes.NewReader(alpha.Body.Bytes()))
	if err != nil || alpha.Header().Get("Content-Type") != "image/png" || transparent.Bounds().Dx() != 720 {
		t.Fatalf("transparent thumbnail: status %d, headers %v, err %v", alpha.Code, alpha.Header(), err)
	}
	if _, _, _, opacity := transparent.At(0, 0).RGBA(); opacity != 128*257 {
		t.Fatalf("thumbnail changed alpha to %d", opacity)
	}

	palette := color.Palette{color.Black, color.White}
	frame := image.NewPaletted(image.Rect(0, 0, 2, 1), palette)
	second := image.NewPaletted(frame.Bounds(), palette)
	second.SetColorIndex(1, 0, 1)
	var animation bytes.Buffer
	if err := gif.EncodeAll(&animation, &gif.GIF{Image: []*image.Paletted{frame, second}, Delay: []int{10, 10}}); err != nil {
		t.Fatal(err)
	}
	write("animation.gif", animation.Bytes())
	animated := request("animation.gif", sess.User, "&thumb=1", "")
	if animated.Code != http.StatusOK || !bytes.Equal(animated.Body.Bytes(), animation.Bytes()) {
		t.Fatalf("animation fallback changed original GIF: %d, %v", animated.Code, animated.Header())
	}
	if w := request("animation.gif", sess.User, "&thumb=1", animated.Header().Get("ETag")); w.Code != http.StatusNotModified {
		t.Fatalf("animation could not be revalidated: %d", w.Code)
	}
}
