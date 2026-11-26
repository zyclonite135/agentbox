package devicelink

import (
	"io"
	"time"

	"github.com/hashicorp/yamux"
)

// Serve accepts folder streams until the device connection closes.
func Serve(sess *yamux.Session, folders func(io.ReadWriter)) error {
	for {
		stream, err := sess.AcceptStream()
		if err != nil {
			return err
		}
		go func() {
			defer stream.Close()
			_ = stream.SetDeadline(time.Now().Add(5 * time.Minute))
			var kind [1]byte
			if _, err := io.ReadFull(stream, kind[:]); err == nil && kind[0] == StreamFolders && folders != nil {
				folders(stream)
			}
		}()
	}
}
