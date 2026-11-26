package linkapp

import (
	"os/exec"
	"strings"
	"syscall"
)

// Windows autostart is a logon scheduled task. The Startup folder would be
// simpler but pops a console window on every login; schtasks runs it quietly
// and needs no admin rights for a per-user, on-logon task.

const taskName = "AboxLink"

func AutostartStatus() ServiceStatus {
	st := ServiceStatus{Supported: true}
	cmd := exec.Command("schtasks", "/query", "/tn", taskName)
	hideCommandWindow(cmd)
	if err := cmd.Run(); err == nil {
		st.Installed = true
		st.Detail = "已注册为登录时启动的计划任务"
	}
	return st
}

func InstallAutostart() error {
	exe, err := exePath()
	if err != nil {
		return err
	}
	// /tr takes one string; quote the path so spaces in it survive.
	return run("schtasks", "/create", "/f",
		"/tn", taskName,
		"/tr", `"`+exe+`" --daemon`,
		"/sc", "onlogon", "/it",
		"/rl", "limited")
}

func UninstallAutostart() error {
	cmd := exec.Command("schtasks", "/delete", "/f", "/tn", taskName)
	hideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil && !strings.Contains(string(out), "cannot find") {
		return err
	}
	return nil
}

func hideCommandWindow(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
}
