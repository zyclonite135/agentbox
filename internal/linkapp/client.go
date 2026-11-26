package linkapp

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"

	"agentbox/internal/devicelink"
)

// ErrAuthRejected marks a handshake the server refused for auth reasons — the
// token was revoked or expired (changing the account password revokes all
// tokens). Retrying the same token is pointless; the caller must re-login or
// re-pair.
var ErrAuthRejected = errors.New("认证被拒绝")

func tlsConfig(insecure bool) *tls.Config {
	return &tls.Config{InsecureSkipVerify: insecure}
}

func httpClient(insecure bool) *http.Client {
	return &http.Client{
		Timeout:   15 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsConfig(insecure)},
	}
}

// baseURL parses and normalises an agentbox base URL.
func baseURL(server string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(server))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("服务器地址无效: %s", server)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

// RevokeToken best-effort asks the server to invalidate a session token
// (POST /api/logout). Called on unpair so a copied config.json's token can't
// outlive the unpair; a failure is non-fatal since the token also ages out via
// the server-side TTL.
func RevokeToken(server, token string, insecure bool) error {
	base, err := baseURL(server)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, base.String()+"/api/logout", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient(insecure).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("logout: %s", resp.Status)
	}
	return nil
}

// dialDevice opens the authenticated file-sharing connection.
func dialDevice(ctx context.Context, cfg Config) (*yamux.Session, error) {
	base, err := baseURL(cfg.Server)
	if err != nil {
		return nil, err
	}
	scheme := "wss"
	if base.Scheme == "http" {
		scheme = "ws"
	}
	target := (&url.URL{Scheme: scheme, Host: base.Host, Path: base.Path + "/api/device-link"}).String()
	dialer := websocket.Dialer{TLSClientConfig: tlsConfig(cfg.Insecure), HandshakeTimeout: 15 * time.Second}
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+cfg.Token)
	shares := make([]devicelink.Folder, 0, len(cfg.Folders))
	for _, folder := range cfg.Folders {
		shares = append(shares, folder.Folder)
	}
	var raw bytes.Buffer
	encoder := json.NewEncoder(&raw)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(shares); err != nil {
		return nil, err
	}
	hdr.Set(devicelink.FoldersHeader, base64.RawURLEncoding.EncodeToString(raw.Bytes()))
	conn, resp, err := dialer.DialContext(ctx, target, hdr)
	if err != nil {
		if resp != nil {
			detail := respDetail(resp)
			if resp.StatusCode == http.StatusUnauthorized {
				return nil, fmt.Errorf("连接 %s: %s%s: %w", target, resp.Status, detail, ErrAuthRejected)
			}
			return nil, fmt.Errorf("连接 %s: %s%s", target, resp.Status, detail)
		}
		return nil, fmt.Errorf("连接 %s: %w", target, err)
	}
	ycfg := yamux.DefaultConfig()
	ycfg.KeepAliveInterval = 15 * time.Second
	ycfg.ConnectionWriteTimeout = 15 * time.Second
	sess, err := yamux.Server(devicelink.NewWSConn(conn), ycfg)
	if err != nil {
		_ = conn.Close()
	}
	return sess, err
}

// respDetail pulls the server's {"error": "..."} reason out of a failed
// handshake response.
func respDetail(resp *http.Response) string {
	if resp.Body == nil {
		return ""
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	var out struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &out) == nil && out.Error != "" {
		return " (" + out.Error + ")"
	}
	return ""
}
