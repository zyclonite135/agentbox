// Package linkapp pairs a computer with AgentBox and serves explicitly shared folders.
package linkapp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is everything the panel persists between runs. The password is
// deliberately absent: pairing exchanges it once for a token, and only the
// token is stored.
type Config struct {
	Server      string        `json:"server"`
	User        string        `json:"user"`
	Token       string        `json:"token"`
	Insecure    bool          `json:"insecure"`
	AutoConnect bool          `json:"auto_connect"`
	Folders     []localFolder `json:"folders"`
}

// Paired reports whether the config carries usable server credentials.
func (c Config) Paired() bool {
	return c.Server != "" && c.User != "" && c.Token != ""
}

// ConfigDir is where the panel keeps its state, overridable for tests and for
// service installs that run as another user.
func ConfigDir() string {
	if d := os.Getenv("ABOX_LINK_HOME"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".abox-link"
	}
	return filepath.Join(home, ".abox-link")
}

func configPath() string { return filepath.Join(ConfigDir(), "config.json") }

// LoadConfig reads the stored config; a missing file yields a zero Config and
// no error, which the panel renders as the first-run pairing screen.
func LoadConfig() (Config, error) {
	var c Config
	raw, err := os.ReadFile(configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return Config{}, fmt.Errorf("配置文件损坏: %w", err)
	}
	c.Server = strings.TrimRight(strings.TrimSpace(c.Server), "/")
	return c, nil
}

// SaveConfig writes the config atomically with owner-only permissions — it
// holds a session token.
func SaveConfig(c Config) error {
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}
