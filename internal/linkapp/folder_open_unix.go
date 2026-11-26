//go:build unix

package linkapp

import (
	"os"

	"golang.org/x/sys/unix"
)

func openLocalEntry(root *os.Root, name string, directory bool) (*os.File, error) {
	flags := os.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if directory {
		flags |= unix.O_DIRECTORY
	}
	file, err := root.OpenFile(name, flags, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !directory && !info.Mode().IsRegular() {
		file.Close()
		return nil, os.ErrNotExist
	}
	return file, nil
}
