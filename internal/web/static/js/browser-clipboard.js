import { api } from "./api.js";
import { t } from "./i18n.js";
import { $, toast } from "./util.js";
function path(target) { return "/sessions/" + encodeURIComponent(target.id) + "/browser/clipboard"; }
function sendShortcut(view, key) {
    view.sendKey(0xffe3, "ControlLeft", true);
    view.sendKey(key.charCodeAt(0), "Key" + key.toUpperCase());
    view.sendKey(0xffe3, "ControlLeft", false);
}
export function setupBrowserClipboard(screen, getTarget, signal, setCopyFallback) {
    const textarea = $("browser-clipboard");
    let nativeMenu;
    let readPermission;
    let pendingPaste = null;
    let copyAttempt = 0;
    if (typeof navigator.clipboard?.readText === "function" && navigator.permissions) {
        // WebKit can require native confirmation for every new system clipboard
        // value. Keep browser-native keyboard paste there.
        void navigator.permissions.query({ name: "clipboard-read" })
            .then(status => { readPermission = status; }, () => { });
    }
    const available = (target) => !signal.aborted && target.current();
    const revisionOf = (target) => api(path(target) + "?revision=1", { signal })
        .then(result => result.revision, () => undefined);
    async function readChange(target, revision, stillCopying = () => true) {
        if (revision === undefined)
            return "";
        for (const delay of [60, 100, 170, 260, 400]) {
            await new Promise(resolve => window.setTimeout(resolve, delay));
            if (!stillCopying() || !available(target) || !screen.contains(document.activeElement))
                break;
            const result = await api(path(target) + "?after=" + revision, { signal });
            if (!stillCopying() || !available(target) || !screen.contains(document.activeElement))
                break;
            if (result.revision !== revision)
                return result.text;
        }
        return "";
    }
    async function copyToDevice(target, pendingText) {
        const attempt = ++copyAttempt;
        const current = () => attempt === copyAttempt && available(target);
        const text = pendingText.then(value => {
            if (!current() || !value)
                throw new DOMException("No copied text", "AbortError");
            textarea.value = value;
            return value;
        });
        try {
            // Safari checks activation at write(), before the remote read finishes.
            const clipboard = navigator.clipboard;
            if (clipboard?.write && typeof ClipboardItem !== "undefined") {
                const blob = text.then(value => new Blob([value], { type: "text/plain" }));
                void blob.catch(() => { });
                await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
            }
            else {
                await clipboard?.writeText(await text);
                if (!clipboard)
                    throw new Error();
            }
            if (current()) {
                setCopyFallback(false);
                toast(t("已复制"));
            }
        }
        catch {
            try {
                await text;
                if (current()) {
                    toast(t(setCopyFallback(true) ? "浏览器不允许直接写入剪贴板，请手动复制下面的文字。" : "浏览器拒绝写入剪贴板"), true);
                }
            }
            catch (error) {
                if (current() && !(error instanceof DOMException && error.name === "AbortError")) {
                    toast(error.message, true);
                }
            }
        }
    }
    function cancelPaste() {
        if (!pendingPaste)
            return;
        pendingPaste.cancelled = true;
        if (!pendingPaste.uploading)
            pendingPaste = null;
    }
    function cancelOnInteraction(event) {
        if (!pendingPaste || !event.isTrusted)
            return;
        if (event instanceof KeyboardEvent && (event.repeat || ["Control", "Meta", "Shift", "Alt"].includes(event.key)))
            return;
        if ((event.type === "pointerdown" || (event instanceof KeyboardEvent && ["Enter", " "].includes(event.key)))
            && event.target instanceof Node && pendingPaste.source?.contains(event.target))
            return;
        cancelPaste();
    }
    document.addEventListener("pointerdown", cancelOnInteraction, { capture: true, signal });
    document.addEventListener("pointerdown", event => {
        if (event.isTrusted && event.target instanceof Node && !screen.contains(event.target))
            closeNativeMenu();
    }, { capture: true, signal });
    document.addEventListener("keydown", cancelOnInteraction, { capture: true, signal });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            cancelPaste();
            closeNativeMenu();
        }
    }, { signal });
    async function pasteRemote(target, getText, source) {
        if (pendingPaste || !available(target))
            return;
        const paste = { source, cancelled: false, uploading: false };
        const screenFocused = screen.contains(document.activeElement);
        const canPaste = () => !paste.cancelled && available(target) &&
            (!screenFocused || screen.contains(document.activeElement));
        pendingPaste = paste;
        try {
            const text = await getText();
            if (!text || !canPaste())
                return;
            paste.uploading = true;
            await api(path(target), { method: "POST", body: JSON.stringify({ text }), signal });
            if (!canPaste())
                return;
            target.view.focus();
            sendShortcut(target.view, "v");
        }
        catch (error) {
            if (canPaste())
                toast(error.message, true);
        }
        finally {
            if (pendingPaste === paste)
                pendingPaste = null;
        }
    }
    function closeNativeMenu() {
        const menu = nativeMenu;
        nativeMenu = undefined;
        if (!menu)
            return;
        window.clearTimeout(menu.timer);
        if (menu.offered)
            menu.target.view.withdrawClipboardOffer();
    }
    async function supplyNativePaste(menu) {
        const { target, chosenAt } = menu;
        const valid = () => nativeMenu === menu && available(target) && screen.contains(document.activeElement);
        if (!valid())
            return null;
        if (chosenAt === undefined) {
            // Chrome may probe the selection while building the menu. Acknowledge
            // without reading the local clipboard, then re-offer on selection.
            menu.probed = true;
            return "";
        }
        if (performance.now() - chosenAt > 2000)
            return null;
        menu.requested = true;
        try {
            const text = await navigator.clipboard.readText();
            if (!valid() || !text)
                return null;
            if (new TextEncoder().encode(text).byteLength > 48 * 1024) {
                toast(t("剪贴板最多支持 48 KiB 的文字"), true);
                return null;
            }
            return text;
        }
        catch {
            if (valid())
                toast(t("没能读取剪贴板：请允许浏览器访问剪贴板后再试"), true);
            return null;
        }
    }
    function beginNativeMenu(target) {
        closeNativeMenu();
        const prepare = target.nativeClipboard && !!readPermission && readPermission.state !== "denied";
        const menu = {
            target, offered: false, probed: false, requested: false, expires: performance.now() + 12_000,
            revision: Promise.resolve(undefined),
        };
        nativeMenu = menu;
        menu.timer = window.setTimeout(() => {
            if (nativeMenu === menu)
                closeNativeMenu();
        }, 12_000);
        if (!prepare) {
            menu.revision = revisionOf(target);
            return;
        }
        const timeout = new AbortController();
        const timer = window.setTimeout(() => timeout.abort(), 1500);
        const ready = api(path(target) + "?prepare=1", {
            method: "POST", body: "{}", signal: AbortSignal.any([signal, timeout.signal]),
        }).catch(() => undefined).finally(() => window.clearTimeout(timer));
        const forwardInput = ready.then(reply => {
            if (!reply?.prepared || nativeMenu !== menu || !available(target))
                return;
            menu.offered = true;
            void target.view.offerClipboard(() => supplyNativePaste(menu));
        });
        target.view.deferInput(forwardInput);
        menu.revision = ready.then(reply => reply?.revision);
    }
    screen.addEventListener("keydown", event => {
        const target = getTarget();
        if (!target || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
            return;
        if (event.code === "KeyV") {
            // Let the browser deliver its privileged paste event instead of letting
            // noVNC forward the shortcut before the remote clipboard is ready.
            event.stopPropagation();
            closeNativeMenu();
        }
        else if (event.code === "KeyC") {
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat)
                return;
            closeNativeMenu();
            const copied = revisionOf(target).then(previous => {
                if (!available(target) || !screen.contains(document.activeElement))
                    return "";
                sendShortcut(target.view, "c");
                return readChange(target, previous);
            });
            void copyToDevice(target, copied);
        }
    }, { capture: true, signal });
    screen.addEventListener("paste", event => {
        const target = getTarget();
        const text = event.clipboardData?.getData("text/plain");
        if (!target || !text || !screen.contains(document.activeElement))
            return;
        event.preventDefault();
        void pasteRemote(target, () => text);
    }, { capture: true, signal });
    function menuButtonDown(button) {
        const target = getTarget();
        if (!target)
            return;
        if (button === 2) {
            beginNativeMenu(target);
        }
        else if (button === 0 && nativeMenu) {
            const menu = nativeMenu;
            if (menu.chosenAt !== undefined || menu.target.view !== target.view || menu.expires < performance.now()) {
                closeNativeMenu();
            }
            else {
                menu.chosenAt = performance.now();
                if (menu.probed && menu.offered)
                    void target.view.offerClipboard(() => supplyNativePaste(menu));
                window.clearTimeout(menu.timer);
                menu.timer = window.setTimeout(() => {
                    if (nativeMenu === menu)
                        closeNativeMenu();
                }, 12_000);
                const copied = menu.revision.then(previous => readChange(target, previous, () => nativeMenu === menu && !menu.requested));
                if (menu.offered) {
                    // Chromium allows a focused page to write after the copy arrives.
                    // Don't start a pending OS clipboard write while Paste may read it.
                    void copied.then(text => {
                        if (text && nativeMenu === menu && !menu.requested)
                            return copyToDevice(target, Promise.resolve(text));
                    }).catch(error => {
                        if (available(target) && nativeMenu === menu)
                            toast(error.message, true);
                    });
                }
                else
                    void copyToDevice(target, copied);
            }
        }
    }
    screen.addEventListener("mousedown", event => {
        if (event.isTrusted)
            menuButtonDown(event.button);
    }, { capture: true, signal });
    screen.addEventListener("rfb-touch-button", event => menuButtonDown(event.detail), { signal });
    screen.addEventListener("keydown", event => {
        if (!event.isTrusted || event.repeat || event.isComposing)
            return;
        if (event.key === "Escape" || (nativeMenu?.requested && !["Control", "Meta", "Shift", "Alt"].includes(event.key)))
            closeNativeMenu();
        else if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)
            menuButtonDown(0);
    }, { capture: true, signal });
    signal.addEventListener("abort", closeNativeMenu, { once: true });
    $("browser-copy").addEventListener("click", () => {
        const target = getTarget();
        if (target)
            void copyToDevice(target, api(path(target), { signal }).then(reply => reply.text));
    }, { signal });
    const pasteButton = $("browser-paste");
    pasteButton.addEventListener("click", () => {
        const target = getTarget();
        if (target)
            void pasteRemote(target, () => textarea.value, pasteButton);
    }, { signal });
}
