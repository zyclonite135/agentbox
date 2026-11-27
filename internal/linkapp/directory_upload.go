package linkapp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func managerDirectoryAction(ctx context.Context, cfg Config, endpoint, action, parentOrPath, name string) error {
	key := "dir"
	if action == "rename" {
		key = "path"
	}
	body, _ := json.Marshal(map[string]string{"scope": "workspace", key: parentOrPath, "name": name})
	var result map[string]string
	return managerRemoteJSON(ctx, cfg, http.MethodPost, endpoint+"/files/"+action, nil, body, &result)
}

func (p *Panel) sendManagerDirectory(ctx context.Context, cfg Config, root *os.Root, req managerCopy, endpoint string, report func(managerCopyEvent)) error {
	invalidPath := &managerError{http.StatusBadRequest, "无效的文件路径"}
	parent, name := path.Dir(req.Destination), path.Base(req.Destination)
	if name != strings.TrimSpace(name) {
		return invalidPath
	}
	checkSource := func() error {
		current := p.Config()
		if ctx.Err() != nil || current.Token != cfg.Token || current.Server != cfg.Server || current.User != cfg.User || !sameManagerFolder(current, cfg, req.Folder) {
			return context.Canceled
		}
		return nil
	}
	if err := checkSource(); err != nil {
		return err
	}
	if strings.HasPrefix(path.Base(req.Source), downloadTempPrefix) {
		return os.ErrNotExist
	}
	start, err := root.OpenRoot(".")
	if err != nil {
		return err
	}
	source, err := openFolderParents(start, filepath.FromSlash(req.Source))
	if err != nil {
		return err
	}
	defer source.Close()

	var entries []struct{ Name string }
	if err := managerRemoteJSON(ctx, cfg, http.MethodGet, endpoint+"/files", url.Values{"path": {parent}}, nil, &entries); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name == name {
			return os.ErrExist
		}
	}

	// Publish only after every file has arrived. The final rename refuses to overwrite an existing entry.
	stageName := ".abox-link-upload-" + rand.Text()
	stage := path.Join(parent, stageName)
	if !managerPath(stage) {
		return invalidPath
	}
	if err := managerDirectoryAction(ctx, cfg, endpoint, "mkdir", parent, stageName); err != nil {
		return err
	}
	published := false
	defer func() {
		if published {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		resp, err := managerFetch(cleanup, cfg, http.MethodDelete, endpoint+"/files", url.Values{"path": {stage}}, nil, 0, 0)
		if err == nil {
			_ = resp.Body.Close()
		} else {
			var failure *managerError
			if !errors.As(err, &failure) || failure.status != http.StatusNotFound {
				p.sup.Logf("清理未完成的文件夹传输 %q：%v", stage, err)
			}
		}
	}()

	var transferred int64
	var copyTree func(src, dst string) error
	copyTree = func(src, dst string) error {
		if err := checkSource(); err != nil {
			return err
		}
		dir, err := openFolderEntry(source, src, true)
		if err != nil {
			return err
		}
		children, err := dir.ReadDir(-1)
		_ = dir.Close()
		if err != nil {
			return err
		}
		for _, entry := range children {
			leaf := entry.Name()
			if strings.HasPrefix(leaf, downloadTempPrefix) || (!entry.IsDir() && !entry.Type().IsRegular()) {
				continue
			}
			childSrc, childDst := path.Join(src, leaf), path.Join(dst, leaf)
			if !managerPath(leaf) || !managerPath(childSrc) || !managerPath(childDst) || entry.IsDir() && leaf != strings.TrimSpace(leaf) {
				return invalidPath
			}
			if err := checkSource(); err != nil {
				return err
			}
			if entry.IsDir() {
				if err := managerDirectoryAction(ctx, cfg, endpoint, "mkdir", dst, leaf); err != nil {
					return err
				}
				if err := copyTree(childSrc, childDst); err != nil {
					return err
				}
				continue
			}
			offset := transferred
			file := managerCopy{Source: childSrc, Destination: childDst}
			written, err := sendManagerFile(ctx, cfg, source, file, endpoint, func(event managerCopyEvent) {
				report(managerCopyEvent{Bytes: offset + event.Bytes})
			})
			if err != nil {
				return err
			}
			transferred += written
			report(managerCopyEvent{Bytes: transferred})
		}
		return nil
	}
	if err := copyTree(".", stage); err != nil {
		return err
	}

	p.actions.Lock()
	defer p.actions.Unlock()
	if err := checkSource(); err != nil {
		return err
	}
	if err := managerDirectoryAction(ctx, cfg, endpoint, "rename", stage, name); err != nil {
		return err
	}
	published = true
	return nil
}
