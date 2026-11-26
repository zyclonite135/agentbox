//go:build !windows

package linkapp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
)

// Other platforms use the browser path in RunPanel.
func runDesktopPanel(ctx context.Context, _ string, _ bool, _ *Panel) error {
	<-ctx.Done()
	return nil
}

func ReportStartupError(err error, _ bool) {
	fmt.Fprintln(os.Stderr, "abox-link:", err)
}

func hideCommandWindow(_ *exec.Cmd) {}
