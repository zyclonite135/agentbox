package linkapp

import "os"

func openLocalEntry(root *os.Root, name string, directory bool) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil || directory && !before.IsDir() || !directory && !before.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) {
		file.Close()
		return nil, os.ErrNotExist
	}
	return file, nil
}
