package server

import (
	"io"
	"net/http"
	"path/filepath"

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
	f, err := dir.OpenFile(r.URL.Query().Get("path"))
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
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
