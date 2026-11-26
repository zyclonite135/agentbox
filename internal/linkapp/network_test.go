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

	"agentbox/internal/netaccess"
	"agentbox/internal/tunnel"
	"github.com/gorilla/websocket"
)

func TestTransparentCapabilityNegotiation(t *testing.T) {
	for _, supported := range []bool{false, true} {
		t.Run(map[bool]string{false: "old-server", true: "new-server"}[supported], func(t *testing.T) {
			seen := make(chan []string, 1)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, err := base64.RawURLEncoding.DecodeString(r.Header.Get(netaccess.RulesHeader))
				var rules []string
				if err != nil || json.Unmarshal(raw, &rules) != nil || r.Header.Get(netaccess.CapabilityHeader) != netaccess.Protocol ||
					r.Header.Get(tunnel.FeaturesHeader) != tunnel.SelfFeature {
					http.Error(w, "bad rules", 400)
					return
				}
				seen <- rules
				hdr := http.Header{}
				if supported {
					hdr.Set(netaccess.CapabilityHeader, netaccess.Protocol)
				}
				up := websocket.Upgrader{}
				conn, err := up.Upgrade(w, r, hdr)
				if err != nil {
					return
				}
				defer conn.Close()
				for {
					if _, _, err = conn.ReadMessage(); err != nil {
						return
					}
				}
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			sess, _, err := dialTunnel(ctx, Config{Server: srv.URL, User: "alice", Token: "synthetic", Transparent: true, Allow: []string{"DB.corp:443"}}, nil)
			if supported {
				if err != nil {
					t.Fatal(err)
				}
				sess.Close()
			} else if err == nil {
				sess.Close()
				t.Fatal("silently accepted old server")
			}
			select {
			case rules := <-seen:
				if len(rules) != 1 || rules[0] != "db.corp:443" {
					t.Fatal(rules)
				}
			case <-ctx.Done():
				t.Fatal("rules not sent")
			}
		})
	}
}

func TestFoldersOnlyDoesNotRequireTransparentAccess(t *testing.T) {
	folders := make([]localFolder, tunnel.MaxFolders)
	for i := range folders {
		folders[i] = localFolder{Folder: tunnel.Folder{ID: strings.Repeat(string(rune('a'+i)), 26), Name: strings.Repeat("&", 128)}, Path: "/local/private"}
	}
	for _, shares := range [][]localFolder{folders, {}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(netaccess.CapabilityHeader) != "" || r.Header.Get(netaccess.RulesHeader) != "" {
				http.Error(w, "transparent access disabled", http.StatusConflict)
				return
			}
			header := r.Header.Get(tunnel.FoldersHeader)
			raw, err := base64.RawURLEncoding.DecodeString(header)
			var catalog []tunnel.Folder
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
		cfg := Config{Server: srv.URL, User: "alice", Token: "synthetic", Transparent: true, Folders: shares}
		wl, maps, err := cfg.Validate()
		if err != nil || len(wl) != 0 || len(maps) != 0 {
			srv.Close()
			t.Fatalf("folders-only configuration parsed as network access: %v, %v, %v", wl, maps, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		sess, _, err := dialTunnel(ctx, cfg, maps)
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
func TestTransparentValidationKeepsLegacyRules(t *testing.T) {
	cfg := Config{Allow: []string{"0.0.0.0/0"}}
	if _, _, err := cfg.Validate(); err != nil {
		t.Fatal("legacy config rejected", err)
	}
	cfg.Transparent = true
	if _, _, err := cfg.Validate(); err == nil {
		t.Fatal("transparent default route accepted")
	}
}
