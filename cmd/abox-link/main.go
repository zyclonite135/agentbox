// abox-link pairs with AgentBox and shares selected folders over a read-only connection.
package main

//go:generate go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --manifest none --icon ../../desktop/src-tauri/icons/icon.ico --out icon

import (
	"flag"
	"fmt"
	"os"

	"agentbox/internal/buildinfo"
	"agentbox/internal/linkapp"
)

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-version" || os.Args[1] == "version") {
		fmt.Println(buildinfo.String("abox-link"))
		return
	}
	daemon := flag.Bool("daemon", false, "start in the background")
	browser := flag.Bool("browser", false, "open the panel in the default browser")
	addr := flag.String("addr", linkapp.DefaultAddr, "panel listen address (loopback only)")
	flag.Parse()
	if err := linkapp.RunPanel(linkapp.RunOptions{Addr: *addr, Daemon: *daemon, Browser: *browser}); err != nil {
		linkapp.ReportStartupError(err, *daemon || *browser)
		os.Exit(1)
	}
}
