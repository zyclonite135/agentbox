package devicelink

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
)

func TestServeAcceptsOnlyFolderStreams(t *testing.T) {
	left, right := net.Pipe()
	client, err := yamux.Client(left, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	device, err := yamux.Server(right, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer device.Close()
	go Serve(device, func(stream io.ReadWriter) { _, _ = stream.Write([]byte("folders")) })
	for _, kind := range []byte{1, StreamFolders} {
		stream, err := client.OpenStream()
		if err != nil {
			t.Fatal(err)
		}
		_ = stream.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := stream.Write([]byte{kind}); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(stream)
		_ = stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		if kind == StreamFolders && string(body) != "folders" || kind != StreamFolders && len(body) != 0 {
			t.Fatalf("stream %d dispatched incorrectly: %q", kind, body)
		}
	}
}
