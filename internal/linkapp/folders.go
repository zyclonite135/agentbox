package linkapp

import (
	"crypto/rand"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"agentbox/internal/devicelink"
)

const downloadTempPrefix = ".abox-link-download-"

type localFolder struct {
	devicelink.Folder
	Path string `json:"path"`
}

func openLocalFolder(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) {
		return nil, os.ErrNotExist
	}
	volume := filepath.VolumeName(path)
	anchor := volume + string(filepath.Separator)
	root, err := os.OpenRoot(anchor)
	if err != nil {
		return nil, err
	}
	relative := strings.TrimPrefix(filepath.Clean(path), anchor)
	if relative == "" {
		return root, nil
	}
	return openFolderParents(root, relative)
}

// Each parent handle pins the checked directory before opening the next name.
// This consumes the input handle, returning only the final one.
func openFolderParents(root *os.Root, relative string) (*os.Root, error) {
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		info, err := root.Lstat(part)
		if err != nil || !info.IsDir() {
			root.Close()
			return nil, os.ErrNotExist
		}
		next, err := root.OpenRoot(part)
		root.Close()
		if err != nil {
			return nil, err
		}
		actual, err := next.Stat(".")
		if err != nil || !os.SameFile(info, actual) {
			next.Close()
			return nil, os.ErrNotExist
		}
		root = next
	}
	return root, nil
}

// Resolve one component at a time so links in intermediate directories are
// rejected by the same identity check as links in a configured folder path.
func openFolderEntry(root *os.Root, name string, directory bool) (*os.File, error) {
	dir, leaf := filepath.Split(filepath.FromSlash(name))
	if dir != "" {
		start, err := root.OpenRoot(".")
		if err != nil {
			return nil, err
		}
		root, err = openFolderParents(start, strings.TrimSuffix(dir, string(filepath.Separator)))
		if err != nil {
			return nil, err
		}
		defer root.Close()
	}
	if strings.HasPrefix(leaf, downloadTempPrefix) {
		return nil, os.ErrNotExist
	}
	info, err := root.Lstat(leaf)
	if err != nil || directory && !info.IsDir() || !directory && !info.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	file, err := openLocalEntry(root, leaf, directory)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		file.Close()
		return nil, os.ErrNotExist
	}
	return file, nil
}

func folderHandler(folders []localFolder) func(io.ReadWriter) {
	if len(folders) == 0 {
		return nil
	}
	active := make(chan struct{}, 4)
	return func(stream io.ReadWriter) {
		var req devicelink.FolderRequest
		fail := func(code string) { _ = devicelink.WriteFolderMessage(stream, devicelink.FolderResponse{Error: code}) }
		select {
		case active <- struct{}{}:
			defer func() { <-active }()
		default:
			fail("busy")
			return
		}
		if devicelink.ReadFolderMessage(stream, &req) != nil || !devicelink.ValidFolderPath(req.Path) ||
			!filepath.IsLocal(filepath.FromSlash(req.Path)) || req.Offset < 0 || req.Offset > 1_000_000 ||
			req.Read && (req.Path == "." || req.Limit < 0) {
			fail("invalid")
			return
		}
		var path string
		for _, folder := range folders {
			if folder.ID == req.ID {
				path = folder.Path
				break
			}
		}
		root, err := openLocalFolder(path)
		if err != nil {
			fail("missing")
			return
		}
		defer root.Close()
		f, err := openFolderEntry(root, req.Path, !req.Read)
		if err != nil {
			fail("missing")
			return
		}
		defer f.Close()
		if req.Read {
			info, err := f.Stat()
			if err != nil {
				fail("missing")
				return
			}
			if info.Size() > req.Limit {
				fail("too_large")
				return
			}
			if devicelink.WriteFolderMessage(stream, devicelink.FolderResponse{Size: info.Size()}) == nil {
				_, _ = io.CopyN(stream, f, info.Size())
			}
			return
		}
		res, err := listLocalFolder(f, req.Offset)
		if err != nil {
			fail("missing")
			return
		}
		_ = devicelink.WriteFolderMessage(stream, res)
	}
}

func listLocalFolder(f *os.File, offset int) (devicelink.FolderResponse, error) {
	var result devicelink.FolderResponse
	for remaining := offset; remaining > 0; {
		entries, err := f.ReadDir(min(remaining, devicelink.FolderPageSize))
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return result, err
		}
		remaining -= len(entries)
	}
	entries, err := f.ReadDir(devicelink.FolderPageSize)
	if err != nil && err != io.EOF {
		return result, err
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil && (info.IsDir() || info.Mode().IsRegular()) && entry.Name() != "." &&
			!strings.HasPrefix(entry.Name(), downloadTempPrefix) && devicelink.ValidFolderPath(entry.Name()) && filepath.IsLocal(entry.Name()) {
			result.Entries = append(result.Entries, devicelink.FolderEntry{Name: entry.Name(), Dir: info.IsDir(), Size: info.Size()})
		}
	}
	if len(entries) == devicelink.FolderPageSize {
		result.Next = offset + len(entries)
	}
	return result, nil
}

func (p *Panel) handleFolders(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		Path string `json:"path"`
		ID   string `json:"id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	p.actions.Lock()
	defer p.actions.Unlock()
	p.mu.Lock()
	cfg := p.cfg
	p.mu.Unlock()
	if !cfg.Paired() {
		writeErr(w, http.StatusConflict, "请先接入服务器")
		return
	}
	cfg.Folders = append([]localFolder{}, cfg.Folders...)
	if req.ID != "" {
		previous := len(cfg.Folders)
		for i, folder := range cfg.Folders {
			if folder.ID == req.ID {
				cfg.Folders = append(cfg.Folders[:i], cfg.Folders[i+1:]...)
				break
			}
		}
		if len(cfg.Folders) == previous {
			writeJSON(w, http.StatusOK, p.state())
			return
		}
	} else {
		path := req.Path
		// Explorer's Copy as path includes a pair of quotes.
		if len(path) >= 2 && path[0] == '"' && path[len(path)-1] == '"' {
			path = path[1 : len(path)-1]
		}
		name := strings.TrimSpace(req.Name)
		if !filepath.IsAbs(path) || !devicelink.ValidFolderName(name) || len(cfg.Folders) >= devicelink.MaxFolders {
			writeErr(w, http.StatusBadRequest, "请输入有效的文件夹名称与绝对路径（最多 16 个）")
			return
		}
		path, err := filepath.EvalSymlinks(path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "无法打开本机文件夹")
			return
		}
		root, err := openLocalFolder(path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "无法打开本机文件夹")
			return
		}
		root.Close()
		cfg.Folders = append(cfg.Folders, localFolder{Folder: devicelink.Folder{ID: rand.Text(), Name: name}, Path: filepath.Clean(path)})
	}
	if err := SaveConfig(cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	p.mu.Lock()
	p.cfg = cfg
	p.mu.Unlock()
	if p.sup.Running() {
		p.sup.Stop()
		if err := p.sup.Start(cfg); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, p.state())
}
