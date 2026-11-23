package server

import (
	"archive/zip"
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"agentbox/internal/safefs"
	"agentbox/internal/store"
)

const chatFileResultsHint = "When you create files for the user to download, put exactly one fenced agentbox-files block at the end of your final answer. Its contents must be JSON, for example {\"title\":\"Website\",\"files\":[{\"path\":\"website/index.html\"},{\"path\":\"website/css/style.css\",\"bytes\":1200}]}. Use exact paths relative to /workspace, include all dependencies needed by the deliverable, and list only files intended for the user. The title and byte sizes are optional. Omit the block if there are no deliverable files."

const maxChatFiles = 512
const maxChatArchiveBytes = 256 << 20

var chatArchiveSlots = make(chan struct{}, 2)

func chatResultPath(name string) bool {
	if len(name) > 1024 || name == "." || !fs.ValidPath(name) || strings.ContainsAny(name, "\\:\x00\r\n") {
		return false
	}
	for part := range strings.SplitSeq(strings.ToLower(name), "/") {
		switch part {
		case ".git", ".agentbox", ".codex", ".claude", ".ds_store", "thumbs.db":
			return false
		}
	}
	return true
}

func (s *Server) handleChatFilesArchive(w http.ResponseWriter, r *http.Request, sess store.Session) {
	var req struct {
		Paths []string `json:"paths"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 768<<10))
	if dec.Decode(&req) != nil || dec.Decode(new(any)) != io.EOF || len(req.Paths) < 5 || len(req.Paths) > maxChatFiles {
		writeErr(w, http.StatusBadRequest, "invalid file list")
		return
	}
	seen := make(map[string]bool, len(req.Paths))
	for _, name := range req.Paths {
		if !chatResultPath(name) || seen[name] {
			writeErr(w, http.StatusBadRequest, "invalid file path")
			return
		}
		seen[name] = true
	}
	select {
	case chatArchiveSlots <- struct{}{}:
		defer func() { <-chatArchiveSlots }()
	default:
		writeErr(w, http.StatusServiceUnavailable, "archive creation is busy")
		return
	}
	root, err := s.openDataDir(s.workspaceDir(sess))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	tmp, err := os.CreateTemp("", "agentbox-chat-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "archive creation failed")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	zw := zip.NewWriter(tmp)
	remaining := int64(maxChatArchiveBytes)
	for _, name := range req.Paths {
		if r.Context().Err() != nil {
			return
		}
		size, status := addChatArchiveFile(zw, root, name, remaining)
		if status != 0 {
			writeErr(w, status, http.StatusText(status))
			return
		}
		remaining -= size
	}
	if err := zw.Close(); err != nil {
		writeErr(w, http.StatusInternalServerError, "archive creation failed")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "project.zip"}))
	http.ServeContent(w, r, "project.zip", time.Time{}, tmp)
}

func addChatArchiveFile(zw *zip.Writer, root *safefs.Root, name string, remaining int64) (int64, int) {
	f, err := root.OpenFile(name)
	if err != nil {
		return 0, http.StatusNotFound
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, http.StatusNotFound
	}
	if info.Size() > remaining {
		return 0, http.StatusRequestEntityTooLarge
	}
	h, err := zip.FileInfoHeader(info)
	if err != nil {
		return 0, http.StatusInternalServerError
	}
	h.Name, h.Method = name, zip.Deflate
	out, err := zw.CreateHeader(h)
	if err != nil {
		return 0, http.StatusInternalServerError
	}
	if _, err := io.CopyN(out, f, info.Size()); err != nil {
		return 0, http.StatusInternalServerError
	}
	return info.Size(), 0
}
