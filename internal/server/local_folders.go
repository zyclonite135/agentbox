package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"agentbox/internal/dockerx"
	"agentbox/internal/safefs"
	"agentbox/internal/store"
	"agentbox/internal/tunnel"

	"github.com/hashicorp/yamux"
)

type linkFolderCatalog struct {
	Owner   time.Time       `json:"owner"`
	Folders []tunnel.Folder `json:"folders"`
}

func parseLinkFolders(header string) ([]tunnel.Folder, error) {
	if header == "" {
		return nil, nil // old client
	}
	var folders []tunnel.Folder
	raw, err := base64.RawURLEncoding.DecodeString(header)
	if err != nil || len(raw) > 16<<10 || json.Unmarshal(raw, &folders) != nil || folders == nil || len(folders) > tunnel.MaxFolders {
		return nil, errors.New("invalid folder catalog")
	}
	seen := make(map[string]bool, len(folders))
	for _, folder := range folders {
		if seen[folder.ID] || !tunnel.ValidFolderID(folder.ID) || !tunnel.ValidFolderName(folder.Name) {
			return nil, errors.New("invalid folder metadata")
		}
		seen[folder.ID] = true
	}
	return folders, nil
}

func (s *Server) userFolderRoot(user string) (*safefs.Root, error) {
	return s.openDataDir(filepath.Join(s.cfg.DataDir, "users", user))
}

func (s *Server) saveLinkFolders(user store.User, folders []tunnel.Folder) error {
	root, err := s.userFolderRoot(user.Name)
	if err != nil {
		return err
	}
	defer root.Close()
	const name = "local-folders.json"
	if len(folders) == 0 {
		err := root.Remove(name)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	body, _ := json.Marshal(linkFolderCatalog{Owner: user.CreatedAt, Folders: folders})
	_, err = root.WriteFile(name, body, safefs.WriteOptions{Mode: 0600})
	return err
}

func (s *Server) savedLinkFolders(user store.User) []tunnel.Folder {
	root, err := s.userFolderRoot(user.Name)
	if err != nil {
		return nil
	}
	defer root.Close()
	// JSON encoding on disk can escape characters that were sent literally in
	// the handshake, so leave room for a full catalog of 16 display names.
	raw, err := root.ReadFile("local-folders.json", 16<<10)
	var catalog linkFolderCatalog
	if err != nil || json.Unmarshal(raw, &catalog) != nil || !catalog.Owner.Equal(user.CreatedAt) {
		return nil
	}
	return catalog.Folders
}

func (s *Server) liveLinkFolders(user store.User) (*yamux.Session, []tunnel.Folder) {
	hub := s.tunnels
	hub.mu.RLock()
	session, info := hub.conns[user.Name], hub.info[user.Name]
	hub.mu.RUnlock()
	if session == nil || session.IsClosed() || info.folders == nil {
		return nil, nil
	}
	owner, valid := s.store.TokenUser(info.folderToken)
	if !valid || owner.Name != user.Name || !owner.CreatedAt.Equal(user.CreatedAt) {
		return nil, nil
	}
	return session, info.folders
}

// Local-folder endpoints only accept the authenticated user's explicit console
// requests. No workspace credential, network rule or port mapping routes here.
func localFolderRequest(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if r.Header.Get("X-AgentBox-Local-Files") != "1" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		writeErr(w, http.StatusForbidden, "local folders require console access")
		return false
	}
	return true
}

func (s *Server) handleLocalFolders(w http.ResponseWriter, r *http.Request) {
	if !localFolderRequest(w, r) {
		return
	}
	user := reqUser(r)
	session, folders := s.liveLinkFolders(user)
	if session == nil {
		folders = s.savedLinkFolders(user)
	}
	if folders == nil {
		folders = []tunnel.Folder{}
	}
	writeJSON(w, http.StatusOK, struct {
		Online  bool            `json:"online"`
		Folders []tunnel.Folder `json:"folders"`
	}{session != nil, folders})
}

func (s *Server) openLocalFolderStream(w http.ResponseWriter, r *http.Request, req tunnel.FolderRequest) (*yamux.Stream, tunnel.FolderResponse, func(), bool) {
	var response tunnel.FolderResponse
	if !tunnel.ValidFolderID(req.ID) || !tunnel.ValidFolderPath(req.Path) {
		writeErr(w, http.StatusBadRequest, "invalid local folder path")
		return nil, response, nil, false
	}
	session, shares := s.liveLinkFolders(reqUser(r))
	if session == nil {
		writeErr(w, http.StatusServiceUnavailable, "local computer is offline")
		return nil, response, nil, false
	}
	found := false
	for _, share := range shares {
		found = found || share.ID == req.ID
	}
	if !found {
		writeErr(w, http.StatusNotFound, "local folder is unavailable")
		return nil, response, nil, false
	}
	stream, err := session.OpenStream()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "local computer is offline")
		return nil, response, nil, false
	}
	_ = stream.SetDeadline(time.Now().Add(5 * time.Minute))
	stop := context.AfterFunc(r.Context(), func() { _ = stream.SetDeadline(time.Now()) })
	closeStream := func() { stop(); _ = stream.Close() }
	_, err = stream.Write([]byte{tunnel.StreamFolders})
	if err == nil {
		err = tunnel.WriteFolderMessage(stream, req)
	}
	if err == nil {
		err = tunnel.ReadFolderMessage(stream, &response)
	}
	if err != nil {
		closeStream()
		writeErr(w, http.StatusBadGateway, "could not read from the local computer")
		return nil, response, nil, false
	}
	if response.Error != "" {
		closeStream()
		status, message := http.StatusNotFound, "local file or folder is unavailable"
		switch response.Error {
		case "busy":
			status, message = http.StatusTooManyRequests, "local computer is busy"
		case "too_large":
			status, message = http.StatusRequestEntityTooLarge, "local file exceeds the upload limit"
		}
		writeErr(w, status, message)
		return nil, response, nil, false
	}
	return stream, response, closeStream, true
}

func (s *Server) handleLocalFolder(w http.ResponseWriter, r *http.Request) {
	if !localFolderRequest(w, r) {
		return
	}
	offset := 0
	q := r.URL.Query()
	if value := q.Get("offset"); value != "" {
		var err error
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > 1_000_000 {
			writeErr(w, http.StatusBadRequest, "invalid folder page")
			return
		}
	}
	name := q.Get("path")
	if name == "" {
		name = "."
	}
	_, result, closeStream, ok := s.openLocalFolderStream(w, r, tunnel.FolderRequest{ID: r.PathValue("folder"), Path: name, Offset: offset})
	if !ok {
		return
	}
	defer closeStream()
	writeJSON(w, http.StatusOK, result)
}

type exactLocalFile struct {
	reader io.LimitedReader
}

func (f *exactLocalFile) Read(buf []byte) (int, error) {
	n, err := f.reader.Read(buf)
	if errors.Is(err, io.EOF) && f.reader.N != 0 {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func (s *Server) handleLocalFile(w http.ResponseWriter, r *http.Request, workspace store.Session) {
	if !localFolderRequest(w, r) {
		return
	}
	var input struct {
		Folder     string `json:"folder"`
		Path       string `json:"path"`
		Attachment bool   `json:"attachment"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input) != nil || input.Path == "." {
		writeErr(w, http.StatusBadRequest, "invalid local file request")
		return
	}
	limit := s.cfg.GetMaxUploadMB() << 20
	stream, response, closeStream, ok := s.openLocalFolderStream(w, r, tunnel.FolderRequest{ID: input.Folder, Path: input.Path, Read: true, Limit: limit})
	if !ok {
		return
	}
	defer closeStream()
	if response.Size < 0 || response.Size > limit {
		writeErr(w, http.StatusRequestEntityTooLarge, "local file exceeds the upload limit")
		return
	}
	if s.cfg.GetStoragePolicy().Mount != "" {
		// The body of this HTTP request is only a path. Reserve the actual
		// transfer separately before storing the bytes from the tunnel.
		release, admitted := s.reserveStorageBytes(r, response.Size, s.cfg.GetResources().MinFreeBytes)
		if !admitted {
			refuseStorageWrite(w, r)
			return
		}
		defer release()
	}
	source := &exactLocalFile{reader: io.LimitedReader{R: stream, N: response.Size}}
	name := path.Base(input.Path)
	if input.Attachment {
		s.saveChatAttachment(w, workspace, name, source)
		return
	}
	stage, err := s.userFolderRoot(workspace.User)
	if err != nil {
		writeFileOpErr(w, err)
		return
	}
	defer stage.Close()
	temp := ".agentbox-local-file-" + rand.Text()
	defer stage.Remove(temp)
	opts := safefs.WriteOptions{Mode: 0o644, Chown: true, UID: dockerx.AgentUID, GID: dockerx.AgentGID, BestEffortChown: os.Geteuid() != 0, MaxBytes: limit, Limit: true}
	if _, err := stage.WriteAtomic(temp, source, opts); err != nil {
		writeFileOpErr(w, err)
		return
	}
	err = s.workspaces().UseExisting(r.Context(), workspace.ID, func(current store.Session) error {
		dest, err := s.openDataDir(s.workspaceDir(current))
		if err != nil {
			return err
		}
		defer dest.Close()
		return stage.RenameTo(temp, dest, name, false)
	})
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			writeErr(w, http.StatusConflict, "a file with that name already exists in the workspace")
			return
		}
		writeFileOpErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}
