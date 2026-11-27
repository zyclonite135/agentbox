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

const (
	desktopName    = "abox-link"
	panelMinWidth  = 380
	panelMinHeight = 460
)

func fitPanelWindow(bounds, workArea application.Rect, size application.Size) application.Rect {
	bounds.Width = min(size.Width, workArea.Width)
	bounds.Height = min(size.Height, workArea.Height)
	bounds.X = max(workArea.X, min(bounds.X, workArea.X+workArea.Width-bounds.Width))
	bounds.Y = max(workArea.Y, min(bounds.Y, workArea.Y+workArea.Height-bounds.Height))
	return bounds
}

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
	paired := panel.Config().Paired()
	sizes := map[bool]application.Size{
		false: {Width: 650, Height: 460},  // Pairing form.
		true:  {Width: 1180, Height: 780}, // Two file panes.
	}
	size := sizes[paired]
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                       "panel",
		Title:                      desktopName,
		Width:                      size.Width,
		Height:                     size.Height,
		MinWidth:                   panelMinWidth,
		MinHeight:                  panelMinHeight,
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

	var quitting atomic.Bool
	quit := func() {
		if quitting.CompareAndSwap(false, true) {
			app.Quit()
		}
	}
	var fitted bool
	fittedSize := size
	fitWindow := func() {
		nextPaired := panel.Config().Paired()
		if quitting.Load() || (fitted && nextPaired == paired) || window.IsMinimised() || window.IsMaximised() || window.IsFullscreen() {
			return
		}
		screen, err := window.GetScreen()
		if err != nil || screen == nil || screen.WorkArea.Width <= 0 || screen.WorkArea.Height <= 0 {
			return
		}
		bounds := window.Bounds()
		if bounds.IsEmpty() {
			return
		}
		workArea := screen.WorkArea
		currentSize := bounds.Size()
		// Keep a size chosen by the user for this view. A fit to a small
		// monitor leaves the preferred size available on larger monitors.
		if currentSize != fittedSize && (fitted || currentSize != fitPanelWindow(bounds, workArea, fittedSize).Size()) {
			sizes[paired] = currentSize
		}
		target := fitPanelWindow(bounds, workArea, sizes[nextPaired])
		paired, fitted = nextPaired, true
		window.SetMinSize(min(panelMinWidth, workArea.Width), min(panelMinHeight, workArea.Height))
		if target != bounds {
			window.SetBounds(target)
		}
		fittedSize.Width, fittedSize.Height = window.Size()
	}
	showWindow := func() {
		if quitting.Load() {
			return
		}
		window.Show()
		// Windows can override the first ShowWindow call with the launcher's startup state.
		if !window.IsVisible() {
			window.Show()
		}
		if window.IsMinimised() {
			window.UnMinimise()
		}
		fitWindow()
		window.Focus()
	}
	show := func() { application.InvokeSync(showWindow) }

	// Retry the initial show once WebView2 has loaded if Windows left the
	// window hidden. A close before then must leave it in the tray.
	showOnLoad := !startHidden
	window.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
		application.InvokeSync(func() {
			fitWindow()
			if showOnLoad {
				showOnLoad = false
				if !window.IsVisible() {
					showWindow()
				}
			}
		})
	})
	window.OnWindowEvent(events.Windows.WindowRestore, func(*application.WindowEvent) {
		application.InvokeSync(fitWindow)
	})
	window.OnWindowEvent(events.Windows.WindowUnFullscreen, func(*application.WindowEvent) {
		application.InvokeSync(fitWindow)
	})
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !quitting.Load() {
			event.Cancel()
			application.InvokeSync(func() {
				showOnLoad = false
				window.Hide()
			})
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
				case <-panel.pairingChanged:
					application.InvokeSync(fitWindow)
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
