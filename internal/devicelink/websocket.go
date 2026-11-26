// Package devicelink carries read-only folder requests over authenticated device connections.
package devicelink

import (
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WSConn adapts a gorilla WebSocket to net.Conn so yamux can run over it. It
// serializes writes (WebSocket forbids concurrent writers) and reassembles
// binary frames into a byte stream.
type WSConn struct {
	c   *websocket.Conn
	r   io.Reader
	wmu sync.Mutex
	rmu sync.Mutex
}

func NewWSConn(c *websocket.Conn) *WSConn { return &WSConn{c: c} }

func (w *WSConn) Read(p []byte) (int, error) {
	w.rmu.Lock()
	defer w.rmu.Unlock()
	for {
		if w.r == nil {
			mt, r, err := w.c.NextReader()
			if err != nil {
				return 0, err
			}
			if mt != websocket.BinaryMessage {
				continue // ignore pings/text; keepalive is control frames
			}
			w.r = r
		}
		n, err := w.r.Read(p)
		if err == io.EOF {
			w.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (w *WSConn) Write(p []byte) (int, error) {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	if err := w.c.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w *WSConn) Close() error         { return w.c.Close() }
func (w *WSConn) LocalAddr() net.Addr  { return w.c.LocalAddr() }
func (w *WSConn) RemoteAddr() net.Addr { return w.c.RemoteAddr() }

func (w *WSConn) SetDeadline(t time.Time) error {
	if err := w.c.SetReadDeadline(t); err != nil {
		return err
	}
	return w.c.SetWriteDeadline(t)
}
func (w *WSConn) SetReadDeadline(t time.Time) error  { return w.c.SetReadDeadline(t) }
func (w *WSConn) SetWriteDeadline(t time.Time) error { return w.c.SetWriteDeadline(t) }
