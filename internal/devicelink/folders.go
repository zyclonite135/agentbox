package devicelink

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	StreamFolders      byte = 2
	FoldersHeader           = "X-Abox-Shared-Folders"
	MaxFolders              = 16
	MaxFolderNameBytes      = 128
	FolderPageSize          = 100
	maxFolderMessage        = 128 << 10
)

type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type FolderRequest struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"`
	Read   bool   `json:"read,omitempty"`
	Limit  int64  `json:"limit,omitempty"`
}

type FolderEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"directory"`
	Size int64  `json:"size"`
}

type FolderResponse struct {
	Error   string        `json:"error,omitempty"`
	Entries []FolderEntry `json:"entries,omitempty"`
	Next    int           `json:"next,omitempty"`
	Size    int64         `json:"size,omitempty"`
}

var folderID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func ValidFolderID(id string) bool { return folderID.MatchString(id) }

func ValidFolderName(name string) bool {
	return name != "" && len(name) <= MaxFolderNameBytes && utf8.ValidString(name) &&
		strings.IndexFunc(name, unicode.IsControl) < 0
}

func ValidFolderPath(name string) bool {
	return len(name) <= 4096 && fs.ValidPath(name) && strings.IndexFunc(name, unicode.IsControl) < 0 &&
		!strings.ContainsAny(name, "\\:")
}

func WriteFolderMessage(w io.Writer, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > maxFolderMessage {
		return errors.New("folder message too large")
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(raw)))
	if _, err := w.Write(size[:]); err != nil {
		return err
	}
	_, err = w.Write(raw)
	return err
}

func ReadFolderMessage(r io.Reader, value any) error {
	var size [4]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(size[:])
	if n == 0 || n > maxFolderMessage {
		return errors.New("invalid folder message size")
	}
	raw := make([]byte, n)
	if _, err := io.ReadFull(r, raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, value)
}
