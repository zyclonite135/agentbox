package linkapp

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"agentbox/internal/tunnel"
)

func TestLocalFolderStream(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	var err error
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	const id = "configured-folder-1"
	for _, base := range []string{root, outside} {
		if err := os.WriteFile(filepath.Join(base, "отчёт.txt"), []byte("report"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "отчёт.txt"), []byte("nested"), 0600); err != nil {
		t.Fatal(err)
	}
	symlink := os.Symlink(outside, filepath.Join(root, "outside"))
	insideLink := os.Symlink(nested, filepath.Join(root, "inside-link"))
	handler := folderHandler([]localFolder{{Folder: tunnel.Folder{ID: id, Name: "Отчёты"}, Path: root}})
	call := func(req tunnel.FolderRequest) (tunnel.FolderResponse, string) {
		t.Helper()
		var stream bytes.Buffer
		if err := tunnel.WriteFolderMessage(&stream, req); err != nil {
			t.Fatal(err)
		}
		handler(&stream)
		var result tunnel.FolderResponse
		if err := tunnel.ReadFolderMessage(&stream, &result); err != nil {
			t.Fatal(err)
		}
		return result, stream.String()
	}
	list, body := call(tunnel.FolderRequest{ID: id, Path: "."})
	if list.Error != "" || len(list.Entries) != 2 || body != "" {
		t.Fatalf("list returned %#v, body=%q", list, body)
	}
	read := tunnel.FolderRequest{ID: id, Path: "отчёт.txt", Read: true, Limit: 6}
	if reply, body := call(read); reply.Size != 6 || body != "report" {
		t.Fatalf("read returned %#v, body=%q", reply, body)
	}
	read.Path = "nested/отчёт.txt"
	if reply, body := call(read); reply.Error != "" || body != "nested" {
		t.Fatalf("nested read returned %#v, body=%q", reply, body)
	}
	for _, denied := range []tunnel.FolderRequest{
		{ID: "unknown-folder", Path: "."},
		{ID: id, Path: "../отчёт.txt", Read: true, Limit: 100},
		{ID: id, Path: "отчёт.txt", Read: true, Limit: 5},
		{ID: id, Path: "отчёт.txt:stream", Read: true, Limit: 100},
	} {
		if reply, body := call(denied); reply.Error == "" || body != "" {
			t.Fatalf("accepted %#v: %#v, %q", denied, reply, body)
		}
	}
	if symlink == nil {
		if reply, body := call(tunnel.FolderRequest{ID: id, Path: "outside/отчёт.txt", Read: true, Limit: 100}); reply.Error == "" || body != "" {
			t.Fatalf("followed unshared directory link: %#v, %q", reply, body)
		}
	}
	if insideLink == nil {
		if reply, body := call(tunnel.FolderRequest{ID: id, Path: "inside-link/отчёт.txt", Read: true, Limit: 100}); reply.Error == "" || body != "" {
			t.Fatalf("followed a directory link inside the share: %#v, %q", reply, body)
		}
	}
}
