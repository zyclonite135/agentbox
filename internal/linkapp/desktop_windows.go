package linkapp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"golang.org/x/sys/windows"
)

const desktopName = "abox-link"

func runDesktopPanel(ctx context.Context, panelURL string, startHidden bool, panel *Panel) error {
	icon, err := staticFS.ReadFile("static/img/tray.png")
	if err != nil {
		return err
	}
	profile, err := filepath.Abs(filepath.Join(ConfigDir(), "webview"))
	if err != nil {
		return err
	}
	app := application.New(application.Options{
		Name: desktopName,
		Icon: icon,
		Windows: application.WindowsOptions{
			WndClass:                      "AboxLinkPanel",
			DisableQuitOnLastWindowClosed: true,
			WebviewUserDataPath:           profile,
		},
	})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                       "panel",
		Title:                      desktopName,
		Width:                      1280,
		Height:                     850,
		MinWidth:                   380,
		MinHeight:                  460,
		Hidden:                     startHidden,
		URL:                        panelURL,
		DefaultContextMenuDisabled: true,
		BackgroundColour:           application.NewRGB(18, 21, 28),
	})
	panel.mu.Lock()
	panel.pickFolder = func() (string, error) {
		name, err := app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).
			AttachToWindow(window).PromptForSingleSelection()
		// Wails keeps the Windows file dialog's cancellation sentinel internal.
		if err != nil && err.Error() == "cancelled by user" {
			return "", nil
		}
		return name, err
	}
	panel.mu.Unlock()
	show := func() {
		window.Show()
		// ShowWindow can use the launcher's initial hidden state on its first call.
		if !window.IsVisible() {
			window.Show()
		}
		if window.IsMinimised() {
			window.UnMinimise()
		}
		window.Focus()
	}

	var quitting atomic.Bool
	quit := func() {
		if quitting.CompareAndSwap(false, true) {
			app.Quit()
		}
	}
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !quitting.Load() {
			event.Cancel()
			window.Hide()
		}
	})

	openLabel, quitLabel := "Open abox-link", "Exit"
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	language, _, _ := kernel32.NewProc("GetUserDefaultUILanguage").Call()
	switch language & 0x3ff {
	case 0x19:
		openLabel, quitLabel = "Открыть abox-link", "Выход"
	case 0x04:
		openLabel, quitLabel = "打开 abox-link", "退出"
	}
	menu := app.NewMenu()
	menu.Add(openLabel).OnClick(func(*application.Context) { show() })
	menu.AddSeparator()
	menu.Add(quitLabel).OnClick(func(*application.Context) { quit() })
	tray := app.SystemTray.New().SetIcon(icon).SetMenu(menu)
	tray.SetTooltip(desktopName)
	tray.OnClick(show)

	done := make(chan struct{})
	defer close(done)
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			for {
				select {
				case <-ctx.Done():
					quit()
					return
				case <-done:
					return
				case <-panel.activate:
					if !quitting.Load() {
						show()
					}
				}
			}
		}()
	})
	return app.Run()
}

func ReportStartupError(err error, background bool) {
	fmt.Fprintln(os.Stderr, "abox-link:", err)
	if background {
		return
	}

	title := windows.StringToUTF16Ptr(desktopName)
	message := windows.StringToUTF16Ptr(err.Error())
	user32 := windows.NewLazySystemDLL("user32.dll")
	const iconError = 0x10
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), iconError)
}
