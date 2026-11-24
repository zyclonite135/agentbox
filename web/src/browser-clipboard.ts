import { api } from "./api.js";
import { t } from "./i18n.js";
import { $, toast } from "./util.js";

type DesktopKeys = {
  focus(): void;
  sendKey(keysym: number, code: string, down?: boolean): void;
};
type Target = {id: string; view: DesktopKeys; current(): boolean};
type ClipboardReply = {text: string; revision?: number};

function path(target: Target) { return "/sessions/" + encodeURIComponent(target.id) + "/browser/clipboard"; }
function sendShortcut(view: DesktopKeys, key: "c" | "v") {
  view.sendKey(0xffe3, "ControlLeft", true);
  view.sendKey(key.charCodeAt(0), "Key" + key.toUpperCase());
  view.sendKey(0xffe3, "ControlLeft", false);
}

export function setupBrowserClipboard(screen: HTMLElement, getTarget: () => Target | null, signal: AbortSignal) {
  const textarea = $<HTMLTextAreaElement>("browser-clipboard");
  let contextCopy: {target: Target; revision: Promise<number | undefined>; expires: number} | undefined;
  let pasteInProgress = false;

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

  async function pasteRemote(target: Target, text: string, keepScreenFocus = false) {
    if (!text || pasteInProgress || !available(target)) return;
    pasteInProgress = true;
    try {
      await api(path(target), {method:"POST", body:JSON.stringify({text}), signal});
      if (!available(target) || (keepScreenFocus && !screen.contains(document.activeElement))) return;
      target.view.focus();
      sendShortcut(target.view, "v");
    } catch (error) {
      if (available(target)) toast((error as Error).message, true);
    } finally {
      pasteInProgress = false;
    }
  }

  async function fromDevice() {
    const target = getTarget();
    if (!target) return;
    try {
      const text = await navigator.clipboard.readText();
      await pasteRemote(target, text);
    } catch {
      if (available(target)) toast(t("没能读取剪贴板：请允许浏览器访问剪贴板后再试"), true);
    }
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
    void pasteRemote(target, text, true);
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
  $("browser-paste").addEventListener("click", () => {
    const target = getTarget();
    if (target) void pasteRemote(target, textarea.value);
  }, {signal});
  $("browser-paste-device").addEventListener("click", () => void fromDevice(), {signal});
  return {fromDevice};
}
