// abox-link pairs with AgentBox and shares selected folders over a read-only connection.
package main

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
	daemon := flag.Bool("daemon", false, "run the panel without opening a browser")
	addr := flag.String("addr", linkapp.DefaultAddr, "panel listen address (loopback only)")
	flag.Parse()
	if err := linkapp.RunPanel(linkapp.RunOptions{Addr: *addr, Daemon: *daemon}); err != nil {
		fmt.Fprintln(os.Stderr, "abox-link:", err)
		os.Exit(1)
	}
}
