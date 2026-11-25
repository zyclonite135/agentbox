package server

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"time"

	"agentbox/internal/store"
)

// Codex writes generated images under its home mount, outside the file browser's scopes.
func (s *Server) handleChatImage(w http.ResponseWriter, r *http.Request, sess store.Session) {
	dir, err := s.openDataDir(filepath.Join(s.homeDir(sess), ".codex", "generated_images"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer dir.Close()
	query := r.URL.Query()
	path := query.Get("path")
	f, err := dir.OpenFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	var header [512]byte
	n, err := io.ReadFull(f, header[:])
	if err != nil && err != io.ErrUnexpectedEOF {
		http.NotFound(w, r)
		return
	}
	contentType := http.DetectContentType(header[:n])
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		http.Error(w, "unsupported image type", http.StatusUnsupportedMediaType)
		return
	}
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "private, no-store")
	if query.Get("dl") == "1" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": info.Name()}))
	} else if query.Get("thumb") == "1" {
		if thumb := s.chatThumbnails.get(r.Context(), sess.ID+"\x00"+path, f, contentType); thumb != nil {
			var content io.ReadSeeker = f
			if thumb.data != nil {
				content = bytes.NewReader(thumb.data)
			}
			w.Header().Set("Content-Type", thumb.contentType)
			w.Header().Set("Cache-Control", "private, no-cache")
			w.Header().Set("ETag", thumb.etag)
			http.ServeContent(w, r, info.Name(), time.Time{}, content)
			return
		}
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
