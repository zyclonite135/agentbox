import { api } from "./api.js";
import { t } from "./i18n.js";
import { $, toast } from "./util.js";

type DesktopKeys = {
  focus(): void;
  sendKey(keysym: number, code: string, down?: boolean): void;
};
type Target = {id: string; view: DesktopKeys; current(): boolean};
type ClipboardReply = {text: string; revision?: number};
type PendingPaste = {source?: HTMLElement; cancelled: boolean; uploading: boolean};

function path(target: Target) { return "/sessions/" + encodeURIComponent(target.id) + "/browser/clipboard"; }
function sendShortcut(view: DesktopKeys, key: "c" | "v") {
  view.sendKey(0xffe3, "ControlLeft", true);
  view.sendKey(key.charCodeAt(0), "Key" + key.toUpperCase());
  view.sendKey(0xffe3, "ControlLeft", false);
}

export function setupBrowserClipboard(screen: HTMLElement, getTarget: () => Target | null, signal: AbortSignal) {
  const textarea = $<HTMLTextAreaElement>("browser-clipboard");
  let contextCopy: {target: Target; revision: Promise<number | undefined>; expires: number} | undefined;
  let pendingPaste: PendingPaste | null = null;

  const available = (target: Target) => !signal.aborted && target.current();
  const revisionOf = (target: Target) => api<ClipboardReply>(path(target) + "?revision=1", {signal})
    .then(result => result.revision, () => undefined);

  async function readChange(target: Target, revision: number | undefined) {
    if (revision === undefined) return "";
    for (const delay of [60, 100, 170, 260, 400]) {
      await new Promise(resolve => window.setTimeout(resolve, delay));
      if (!available(target) || !screen.contains(document.activeElement)) break;
      const result: ClipboardReply = await api<ClipboardReply>(path(target) + "?after=" + revision, {signal});
      if (!available(target) || !screen.contains(document.activeElement)) break;
      if (result.revision !== revision) return result.text;
    }
    return "";
  }

  async function copyToDevice(target: Target, pendingText: Promise<string>) {
    const text = pendingText.then(value => {
      if (!available(target) || !value) throw new DOMException("No copied text", "AbortError");
      textarea.value = value;
      return value;
    });
    try {
      // Safari checks activation at write(), before the remote read finishes.
      const clipboard = navigator.clipboard;
      if (clipboard?.write && typeof ClipboardItem !== "undefined") {
        const blob = text.then(value => new Blob([value], {type:"text/plain"}));
        void blob.catch(() => {});
        await clipboard.write([new ClipboardItem({"text/plain":blob})]);
      } else {
        await clipboard?.writeText(await text);
        if (!clipboard) throw new Error();
      }
      if (available(target)) toast(t("已复制"));
    } catch {
      try {
        await text;
        if (available(target)) toast(t("浏览器拒绝写入剪贴板"), true);
      } catch (error) {
        if (available(target) && !(error instanceof DOMException && error.name === "AbortError")) {
          toast((error as Error).message, true);
        }
      }
    }
  }

  function cancelPaste() {
    if (!pendingPaste) return;
    pendingPaste.cancelled = true;
    if (!pendingPaste.uploading) pendingPaste = null;
  }

  function cancelOnInteraction(event: Event) {
    if (!pendingPaste || !event.isTrusted) return;
    if (event instanceof KeyboardEvent && (event.repeat || ["Control", "Meta", "Shift", "Alt"].includes(event.key))) return;
    if ((event.type === "pointerdown" || (event instanceof KeyboardEvent && ["Enter", " "].includes(event.key)))
      && event.target instanceof Node && pendingPaste.source?.contains(event.target)) return;
    cancelPaste();
  }

  document.addEventListener("pointerdown", cancelOnInteraction, {capture:true, signal});
  document.addEventListener("keydown", cancelOnInteraction, {capture:true, signal});
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelPaste();
  }, {signal});

  async function pasteRemote(target: Target, getText: () => string | Promise<string>, source?: HTMLElement) {
    if (pendingPaste || !available(target)) return;
    const paste = {source, cancelled:false, uploading:false};
    const screenFocused = screen.contains(document.activeElement);
    const canPaste = () => !paste.cancelled && available(target) &&
      (!screenFocused || screen.contains(document.activeElement));
    pendingPaste = paste;
    try {
      const text = await getText();
      if (!text || !canPaste()) return;
      paste.uploading = true;
      await api(path(target), {method:"POST", body:JSON.stringify({text}), signal});
      if (!canPaste()) return;
      target.view.focus();
      sendShortcut(target.view, "v");
    } catch (error) {
      if (canPaste()) toast((error as Error).message, true);
    } finally {
      if (pendingPaste === paste) pendingPaste = null;
    }
  }

  function fromDevice(source?: HTMLElement) {
    const target = getTarget();
    if (!target) return;
    return pasteRemote(target, async () => {
      try { return await navigator.clipboard.readText(); }
      catch { throw new Error(t("没能读取剪贴板：请允许浏览器访问剪贴板后再试")); }
    }, source);
  }

  screen.addEventListener("keydown", event => {
    const target = getTarget();
    if (!target || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.code === "KeyV") {
      // Let the browser deliver its privileged paste event instead of letting
      // noVNC forward the shortcut before the remote clipboard is ready.
      event.stopPropagation();
    } else if (event.code === "KeyC" && navigator.clipboard) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      contextCopy = undefined;
      const copied = revisionOf(target).then(previous => {
        if (!available(target) || !screen.contains(document.activeElement)) return "";
        sendShortcut(target.view, "c");
        return readChange(target, previous);
      });
      void copyToDevice(target, copied);
    }
  }, {capture:true, signal});

  screen.addEventListener("paste", event => {
    const target = getTarget();
    const text = event.clipboardData?.getData("text/plain");
    if (!target || !text || !screen.contains(document.activeElement)) return;
    event.preventDefault();
    void pasteRemote(target, () => text);
  }, {capture:true, signal});

  screen.addEventListener("mousedown", event => {
    const target = getTarget();
    if (!target || !navigator.clipboard || !event.isTrusted) return;
    if (event.button === 2) {
      // A right click arms one native menu selection. Read only a change
      // caused by the subsequent click; ordinary right clicks read no text.
      contextCopy = {target, revision:revisionOf(target), expires:performance.now() + 12_000};
    } else if (event.button === 0 && contextCopy) {
      const copy = contextCopy;
      contextCopy = undefined;
      if (copy.target.view === target.view && copy.expires >= performance.now()) {
        void copyToDevice(target, copy.revision.then(previous => readChange(target, previous)));
      }
    }
  }, {capture:true, signal});
  screen.addEventListener("keydown", event => {
    if (event.key === "Escape") contextCopy = undefined;
  }, {capture:true, signal});

  $("browser-copy").addEventListener("click", () => {
    const target = getTarget();
    if (target) void copyToDevice(target, api<ClipboardReply>(path(target), {signal}).then(reply => reply.text));
  }, {signal});
  const pasteButton = $("browser-paste");
  pasteButton.addEventListener("click", () => {
    const target = getTarget();
    if (target) void pasteRemote(target, () => textarea.value, pasteButton);
  }, {signal});
  const deviceButton = $("browser-paste-device");
  deviceButton.addEventListener("click", () => void fromDevice(deviceButton), {signal});
  return {fromDevice};
}
