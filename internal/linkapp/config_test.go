package linkapp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPaired(t *testing.T) {
	if (Config{Server: "https://a", User: "u"}).Paired() {
		t.Error("a config without a token is not paired")
	}
	if !(Config{Server: "https://a", User: "u", Token: "t"}).Paired() {
		t.Error("full credentials should count as paired")
	}
}

func TestSaveLoadRoundTripAndPermissions(t *testing.T) {
	t.Setenv("ABOX_LINK_HOME", t.TempDir())

	want := Config{
		Server: "https://box.example.com", User: "alice", Token: "tok",
		Folders:     []localFolder{{Path: t.TempDir()}},
		AutoConnect: true,
	}
	if err := SaveConfig(want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.Server != want.Server || got.Token != want.Token || !got.AutoConnect ||
		len(got.Folders) != 1 || got.Folders[0].Path != want.Folders[0].Path {
		t.Fatalf("round trip lost data: %+v", got)
	}

	// The file holds a session token, so it must not be group/world readable.
	fi, err := os.Stat(filepath.Join(ConfigDir(), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("config mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestLoadMissingConfigIsNotAnError(t *testing.T) {
	t.Setenv("ABOX_LINK_HOME", filepath.Join(t.TempDir(), "nope"))
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("first run should not error: %v", err)
	}
	if cfg.Paired() {
		t.Error("a missing config should read as unpaired")
	}
}

func TestLoadCorruptConfigReportsClearly(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ABOX_LINK_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "损坏") {
		t.Fatalf("want a corruption error, got %v", err)
	}
}
