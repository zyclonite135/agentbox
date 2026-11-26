package linkapp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agentbox/internal/devicelink"
	"github.com/gorilla/websocket"
)

func TestDevicePublishesOnlyFolderMetadata(t *testing.T) {
	folders := make([]localFolder, devicelink.MaxFolders)
	for i := range folders {
		folders[i] = localFolder{Folder: devicelink.Folder{ID: strings.Repeat(string(rune('a'+i)), 26), Name: strings.Repeat("&", 128)}, Path: "/local/private"}
	}
	for _, shares := range [][]localFolder{folders, {}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get(devicelink.FoldersHeader)
			raw, err := base64.RawURLEncoding.DecodeString(header)
			var catalog []devicelink.Folder
			if err != nil || len(header) >= 8<<10 || json.Unmarshal(raw, &catalog) != nil || catalog == nil || len(catalog) != len(shares) || strings.Contains(string(raw), "/local/private") {
				http.Error(w, "invalid folder catalog", http.StatusBadRequest)
				return
			}
			up := websocket.Upgrader{}
			conn, err := up.Upgrade(w, r, nil)
			if err == nil {
				defer conn.Close()
				_, _, _ = conn.ReadMessage()
			}
		}))
		cfg := Config{Server: srv.URL, User: "alice", Token: "synthetic", Folders: shares}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		sess, err := dialDevice(ctx, cfg)
		if err == nil {
			sess.Close()
		}
		cancel()
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}
