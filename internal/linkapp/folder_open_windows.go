package linkapp

import "os"

func openLocalEntry(root *os.Root, name string, _ bool) (*os.File, error) {
	return root.Open(name)
}
