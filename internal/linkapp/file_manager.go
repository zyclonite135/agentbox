package linkapp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"agentbox/internal/devicelink"
)

const previewBytes = 12 << 20

func managerPath(name string) bool {
	return devicelink.ValidFolderPath(name) && filepath.IsLocal(filepath.FromSlash(name))
}

type managerEntry struct {
	Name     string    `json:"name"`
	Dir      bool      `json:"directory"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified,omitempty"`
}

type managerError struct {
	status  int
	message string
}

func (e *managerError) Error() string { return e.message }

func writeManagerError(w http.ResponseWriter, err error) {
	var failure *managerError
	switch {
	case errors.As(err, &failure):
		writeErr(w, failure.status, failure.message)
	case errors.Is(err, os.ErrExist):
		writeErr(w, http.StatusConflict, "目标已存在")
	case errors.Is(err, os.ErrNotExist):
		writeErr(w, http.StatusNotFound, "找不到文件或文件夹")
	default:
		writeErr(w, http.StatusBadGateway, "文件操作失败")
	}
}

func (p *Panel) managerFolder(cfg Config, id string) (*os.Root, error) {
	for _, folder := range cfg.Folders {
		if folder.ID == id {
			return openLocalFolder(folder.Path)
		}
	}
	return nil, os.ErrNotExist
}

func (p *Panel) managerLocal(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name := q.Get("path")
	if !managerPath(name) {
		writeErr(w, http.StatusBadRequest, "无效的文件路径")
		return
	}
	root, err := p.managerFolder(p.Config(), q.Get("folder"))
	if err != nil {
		writeManagerError(w, err)
		return
	}
	defer root.Close()

	if q.Get("preview") == "1" {
		f, err := openFolderEntry(root, name, false)
		if err != nil {
			writeManagerError(w, err)
			return
		}
		defer f.Close()
		serveManagerPreview(w, f)
		return
	}
	f, err := openFolderEntry(root, name, true)
	if err != nil {
		writeManagerError(w, err)
		return
	}
	defer f.Close()
	entries, err := f.ReadDir(-1)
	if err != nil {
		writeManagerError(w, err)
		return
	}
	out := []managerEntry{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".abox-link-download-") || !managerPath(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err == nil && (info.IsDir() || info.Mode().IsRegular()) {
			out = append(out, managerEntry{entry.Name(), info.IsDir(), info.Size(), info.ModTime()})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func managerFetch(ctx context.Context, cfg Config, method, endpoint string, query url.Values, body io.Reader, length int64, timeout time.Duration) (*http.Response, error) {
	if !cfg.Paired() {
		return nil, &managerError{http.StatusConflict, "请先接入服务器"}
	}
	base, err := baseURL(cfg.Server)
	if err != nil {
		return nil, err
	}
	base.Path += endpoint
	base.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, base.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	if body != nil {
		req.ContentLength = length
		req.Header.Set("Content-Type", "application/octet-stream")
		if length == 0 {
			req.Body = http.NoBody
		}
	}
	client := httpClient(cfg.Insecure)
	client.Transport.(*http.Transport).DisableKeepAlives = true
	client.Timeout = timeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusConflict:
			return nil, &managerError{resp.StatusCode, "目标已存在"}
		case http.StatusUnauthorized:
			return nil, &managerError{resp.StatusCode, "凭证已失效"}
		case http.StatusForbidden:
			return nil, &managerError{resp.StatusCode, "没有文件操作权限"}
		case http.StatusNotFound:
			return nil, &managerError{resp.StatusCode, "找不到文件或文件夹"}
		case http.StatusRequestEntityTooLarge:
			return nil, &managerError{resp.StatusCode, "文件超过上传限制"}
		case http.StatusInsufficientStorage:
			return nil, &managerError{resp.StatusCode, "存储空间不足"}
		default:
			return nil, &managerError{http.StatusBadGateway, "服务器无法完成文件操作"}
		}
	}
	return resp, nil
}

func managerSession(id string) string {
	// Session IDs are opaque URL path segments, including for legacy servers.
	if id == "" || id == "." || id == ".." || len(id) > 128 || strings.ContainsAny(id, "/\\?#:%") {
		return ""
	}
	return "/api/sessions/" + id
}

func managerRemoteJSON(r *http.Request, cfg Config, method, endpoint string, query url.Values, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	resp, err := managerFetch(r.Context(), cfg, method, endpoint, query, reader, int64(len(body)), 20*time.Second)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, 48<<20)).Decode(out)
}

func (p *Panel) managerRemote(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cfg := p.Config()
	if r.URL.Path == "/api/file-manager/workspaces" {
		out := []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{}
		if err := managerRemoteJSON(r, cfg, http.MethodGet, "/api/sessions", nil, nil, &out); err != nil {
			writeManagerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	endpoint := managerSession(q.Get("workspace"))
	name := q.Get("path")
	if endpoint == "" || !managerPath(name) {
		writeErr(w, http.StatusBadRequest, "无效的文件路径")
		return
	}
	if q.Get("preview") == "1" {
		resp, err := managerFetch(r.Context(), cfg, http.MethodGet, endpoint+"/file", url.Values{"path": {name}, "dl": {"1"}}, nil, 0, 20*time.Second)
		if err != nil {
			writeManagerError(w, err)
			return
		}
		defer resp.Body.Close()
		serveManagerPreview(w, resp.Body)
		return
	}

	var entries []struct {
		Name     string    `json:"name"`
		Dir      bool      `json:"is_dir"`
		Size     int64     `json:"size"`
		Modified time.Time `json:"mtime"`
		Mode     string    `json:"mode"`
	}
	if err := managerRemoteJSON(r, cfg, http.MethodGet, endpoint+"/files", url.Values{"path": {name}}, nil, &entries); err != nil {
		writeManagerError(w, err)
		return
	}
	out := []managerEntry{}
	for _, entry := range entries {
		if managerPath(entry.Name) && (entry.Dir || strings.HasPrefix(entry.Mode, "-")) {
			out = append(out, managerEntry{entry.Name, entry.Dir, entry.Size, entry.Modified})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func serveManagerPreview(w http.ResponseWriter, data io.Reader) {
	buf := bufio.NewReader(data)
	head, _ := buf.Peek(512)
	mime := http.DetectContentType(head)
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
	default:
		writeErr(w, http.StatusUnsupportedMediaType, "无法预览此图片")
		return
	}
	content, err := io.ReadAll(io.LimitReader(buf, previewBytes+1))
	if err != nil || len(content) > previewBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "图片过大，无法预览")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(content)
}

func (p *Panel) managerRemoteAction(w http.ResponseWriter, r *http.Request) {
	var req struct{ Workspace, Action, Path, Name, Destination string }
	if !decodeBody(w, r, &req) {
		return
	}
	endpoint := managerSession(req.Workspace)
	if endpoint == "" || !managerPath(req.Path) || req.Path == "." && req.Action != "mkdir" {
		writeErr(w, http.StatusBadRequest, "无效的文件路径")
		return
	}
	method := http.MethodPost
	var input map[string]string
	var query url.Values
	switch req.Action {
	case "mkdir", "rename":
		if req.Name == "." || !managerPath(req.Name) || strings.Contains(req.Name, "/") || req.Name != strings.TrimSpace(req.Name) {
			writeErr(w, http.StatusBadRequest, "无效的文件路径")
			return
		}
		input = map[string]string{"scope": "workspace", "name": req.Name, "path": req.Path, "dir": req.Path}
		endpoint += "/files/" + req.Action
	case "move":
		if !managerPath(req.Destination) {
			writeErr(w, http.StatusBadRequest, "无效的文件路径")
			return
		}
		input = map[string]string{"source_scope": "workspace", "source_path": req.Path, "destination_scope": "workspace", "destination_dir": req.Destination}
		endpoint += "/files/move"
	case "delete":
		method = http.MethodDelete
		query = url.Values{"path": {req.Path}}
		endpoint += "/files"
	default:
		writeErr(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	var encoded []byte
	if input != nil {
		encoded, _ = json.Marshal(input)
	}
	var out map[string]any
	if err := managerRemoteJSON(r, p.Config(), method, endpoint, query, encoded, &out); err != nil {
		writeManagerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type managerCopy struct {
	Workspace   string
	Folder      string
	Direction   string
	Source      string
	Destination string
	Replace     bool
}

type managerCopyEvent struct {
	Done     bool   `json:"done,omitempty"`
	Bytes    int64  `json:"bytes"`
	Total    int64  `json:"total"`
	Error    string `json:"error,omitempty"`
	Conflict bool   `json:"conflict,omitempty"`
}

type copyProgress struct {
	source       io.Reader
	total, bytes int64
	last         time.Time
	report       func(managerCopyEvent)
}

func (p *copyProgress) Read(b []byte) (int, error) {
	n, err := p.source.Read(b)
	p.bytes += int64(n)
	if p.last.IsZero() || err != nil || time.Since(p.last) >= 125*time.Millisecond {
		p.report(managerCopyEvent{Bytes: p.bytes, Total: p.total})
		p.last = time.Now()
	}
	return n, err
}

func (p *Panel) managerTransfer(w http.ResponseWriter, r *http.Request) {
	select {
	case p.transfers <- struct{}{}:
		defer func() { <-p.transfers }()
	default:
		writeErr(w, http.StatusTooManyRequests, "文件操作忙，请稍后重试")
		return
	}
	var req managerCopy
	if !decodeBody(w, r, &req) {
		return
	}
	cfg := p.Config()
	endpoint := managerSession(req.Workspace)
	if endpoint == "" || !managerPath(req.Source) || !managerPath(req.Destination) || req.Source == "." || req.Destination == "." ||
		(req.Direction != "upload" && req.Direction != "download") {
		writeErr(w, http.StatusBadRequest, "无效的文件路径")
		return
	}
	root, err := p.managerFolder(cfg, req.Folder)
	if err != nil {
		writeManagerError(w, err)
		return
	}
	defer root.Close()
	if !cfg.Paired() {
		writeManagerError(w, &managerError{http.StatusConflict, "请先接入服务器"})
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	encoder := json.NewEncoder(w)
	controller := http.NewResponseController(w)
	var reportMu sync.Mutex
	finished := false
	report := func(event managerCopyEvent) {
		reportMu.Lock()
		defer reportMu.Unlock()
		if finished {
			return
		}
		finished = event.Done || event.Error != ""
		if encoder.Encode(event) == nil {
			_ = controller.Flush()
		}
	}
	switch req.Direction {
	case "upload":
		err = sendManagerFile(r.Context(), cfg, root, req, endpoint, report)
	case "download":
		err = p.receiveManagerFile(r.Context(), cfg, root, req, endpoint, report)
	}
	if err == nil {
		report(managerCopyEvent{Done: true})
		return
	}
	var failure *managerError
	msg, conflict := "文件操作失败", errors.Is(err, os.ErrExist)
	if errors.As(err, &failure) {
		msg, conflict = failure.message, failure.status == http.StatusConflict
	}
	if errors.Is(err, os.ErrNotExist) {
		msg = "找不到文件或文件夹"
	}
	if conflict {
		msg = "目标已存在"
	}
	report(managerCopyEvent{Error: msg, Conflict: conflict})
}

func sendManagerFile(ctx context.Context, cfg Config, root *os.Root, req managerCopy, endpoint string, report func(managerCopyEvent)) error {
	f, err := openFolderEntry(root, req.Source, false)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	query := url.Values{"path": {req.Destination}}
	if req.Replace {
		query.Set("replace", "1")
	}
	progress := &copyProgress{source: io.LimitReader(f, info.Size()), total: info.Size(), report: report}
	resp, err := managerFetch(ctx, cfg, http.MethodPut, endpoint+"/files/copy", query, progress, info.Size(), 45*time.Minute)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (p *Panel) receiveManagerFile(ctx context.Context, cfg Config, root *os.Root, req managerCopy, endpoint string, report func(managerCopyEvent)) error {
	dir, name := path.Split(req.Destination)
	if !filepath.IsLocal(filepath.FromSlash(req.Destination)) {
		return os.ErrInvalid
	}
	target, err := root.OpenRoot(".")
	if err != nil {
		return err
	}
	if dir != "" {
		target, err = openFolderParents(target, filepath.FromSlash(strings.TrimSuffix(dir, "/")))
		if err != nil {
			return err
		}
	}
	defer target.Close()
	if err := managerDestination(target, name, req.Replace); err != nil {
		return err
	}
	resp, err := managerFetch(ctx, cfg, http.MethodGet, endpoint+"/file", url.Values{"path": {req.Source}, "dl": {"1"}}, nil, 0, 45*time.Minute)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	temp := ".abox-link-download-" + rand.Text()
	f, err := target.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer target.Remove(temp)
	defer f.Close()
	progress := &copyProgress{source: resp.Body, total: resp.ContentLength, report: report}
	written, err := io.Copy(f, progress)
	if err != nil {
		return err
	}
	if resp.ContentLength >= 0 && written != resp.ContentLength {
		return io.ErrUnexpectedEOF
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	// Serialize publication with re-pairing, unlinking, or changing shared folders.
	p.actions.Lock()
	defer p.actions.Unlock()
	current := p.Config()
	if ctx.Err() != nil || current.Token != cfg.Token || current.Server != cfg.Server || !sameManagerFolder(current, cfg, req.Folder) {
		return context.Canceled
	}
	if err := managerDestination(target, name, req.Replace); err != nil {
		return err
	}
	if req.Replace {
		return target.Rename(temp, name)
	}
	return target.Link(temp, name)
}

func sameManagerFolder(current, old Config, id string) bool {
	for _, folder := range current.Folders {
		if folder.ID != id {
			continue
		}
		for _, previous := range old.Folders {
			if previous == folder {
				return true
			}
		}
	}
	return false
}

func managerDestination(target *os.Root, name string, replace bool) error {
	info, err := target.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !replace || !info.Mode().IsRegular() {
		return os.ErrExist
	}
	return nil
}
