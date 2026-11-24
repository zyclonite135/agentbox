import { setAttr, setText, t as i18nText } from "./i18n.js";
import { agentIcon } from "./brand.js";
import { S, bus } from "./state.js";
import { api, wsURL } from "./api.js";
import { enhanceSelects, setSelectValue } from "./select.js";
import { closeMenu, openMenu } from "./menu.js";
import { $, toast } from "./util.js";
import type { BrowserInfo } from "./types.js";

type Desktop = EventTarget & {
 disconnect(): void; focus(): void; clipboardPasteFrom(text: string): void;
 sendKey(keysym: number, code: string, down?: boolean): void;
 scaleViewport: boolean; resizeSession: boolean; qualityLevel: number; compressionLevel: number;
};
let desktop: Desktop | null = null;
let generation = 0;
let controller: AbortController | null = null;
let connected = false;
let busy = false;
let connectTimer = 0;
const CONNECT_TIMEOUT = 20_000;
const compactLayout = matchMedia("(max-width: 760px), (pointer: coarse) and (orientation: landscape) and (max-height: 600px)");
const portraitLayout = matchMedia("(orientation: portrait)");
const qualityModes: Record<string, {quality: number; compression: number}> = {
 smooth: {quality: 3, compression: 2},
 balanced: {quality: 6, compression: 2},
 clear: {quality: 9, compression: 2},
};
function applyQuality(view: Desktop) {
 const mode = qualityModes[$<HTMLSelectElement>("browser-quality").value] || qualityModes.smooth;
 view.qualityLevel = mode.quality;
 view.compressionLevel = mode.compression;
}

function pending() { return busy || (desktop !== null && !connected); }

function state(text: string, compact = "", error = "") {
 $("browser-state").textContent = text;
 const short = $("browser-mobile-state");
 setText(short, compact);
 short.parentElement!.toggleAttribute("data-mobile-text", !!compact);
 const details = $<HTMLDetailsElement>("browser-error-details");
 const explanation = $("browser-error-text");
 if (!error || explanation.textContent !== error) details.open = false;
 details.classList.toggle("hidden", !error);
 explanation.textContent = error;
 updateDot();
}
function problem(message: string) {
 state(message, "浏览器操作失败", message);
}
function updateDot() {
 $("browser-dot").dataset.state = !$("browser-error-details").classList.contains("hidden") ? "error" :
  pending() ? "busy" : connected ? "connected" : "idle";
}
function controls() {
 updateDot();
 const pane = $("tab-browser");
 pane.toggleAttribute("data-connected", connected);
 const more = $<HTMLButtonElement>("browser-more");
 more.disabled = pending();
 if (!connected && compactLayout.matches) {
  if (more.getAttribute("aria-expanded") === "true") closeMenu();
  $<HTMLDetailsElement>("browser-clipboard-panel").open = false;
  if (document.fullscreenElement === pane) void document.exitFullscreen().catch(() => {});
 }
 // 同一时刻只露一个：没连上时「启动浏览器」，连上后「关闭浏览器」
 $("browser-start").classList.toggle("hidden", connected);
 $("browser-stop").classList.toggle("hidden", !connected);
 for (const id of ["browser-stop", "browser-start", "browser-launch", "browser-open"]) {
  $<HTMLButtonElement>(id).disabled = pending();
 }
 for (const button of pane.querySelectorAll<HTMLButtonElement>("[data-browser-url]")) button.disabled = pending();
 $<HTMLButtonElement>("browser-paste").disabled = !connected;
 $<HTMLButtonElement>("browser-copy").disabled = !connected;
}
function resetDesktop(closeTransport = false) {
 window.clearTimeout(connectTimer);
 const old = desktop;
 desktop = null; connected = false;
 if (closeTransport) old?.disconnect();
 $("browser-screen").replaceChildren();
 $("browser-empty").classList.remove("hidden");
 controls();
}
export function browserDisconnect() {
 generation++; busy = false;
 resetDesktop(true);
}
async function connect(id: string, ticket: number, info: BrowserInfo) {
 // Keep native module imports so noVNC assets share Agentbox's content hash.
 const { default: RFB } = await import("../vendor/novnc/core/rfb.js");
 if (ticket !== generation || S.current?.id !== id || S.tab !== "browser") return;
 // Chrome keeps a minimum window width even on a narrower X screen.
 const view: Desktop = new RFB($("browser-screen"), wsURL(`/sessions/${id}/browser/desktop`), {
  minRemoteWidth: 512,
  preserveViewportAspect: () => compactLayout.matches && portraitLayout.matches,
 });
 desktop = view;
 controls();
 view.scaleViewport = true;
 // Older browser images keep proportional scaling if they cannot resize.
 view.resizeSession = true;
 applyQuality(view);
 view.addEventListener("connect", () => {
  if (desktop !== view) return;
  window.clearTimeout(connectTimer);
  connected = true; state(i18nText("已连接 · {p0} · {p1}", { p0: String(info.browser || "Chrome"), p1: String(info.proxy ? i18nText("账号代理出口") : i18nText("服务器出口")) }), "已连接");
  $("browser-empty").classList.add("hidden"); controls();
 });
 let failure = "";
 view.addEventListener("disconnect", () => {
  if (desktop !== view) return;
  resetDesktop();
  if (failure) problem(failure);
  else state(i18nText("连接已断开，可点击连接浏览器重试"), "已断开");
 });
 view.addEventListener("securityfailure", () => {
  if (desktop !== view) return;
  failure = i18nText("远程桌面连接失败，请重新启动浏览器");
  problem(failure);
 });
 connectTimer = window.setTimeout(() => {
  if (desktop !== view || connected) return;
  resetDesktop(true);
  problem(failure || i18nText("连接远程桌面超时，请重试。"));
 }, CONNECT_TIMEOUT);
}

export async function showBrowser() {
 browserDisconnect();
 const id = S.current?.id; if (!id) return;
 const ticket = generation;
 busy = true; controls(); state(i18nText("正在读取浏览器状态…"), "正在读取浏览器状态…");
 try {
  const info = await api<BrowserInfo>(`/sessions/${id}/browser`);
  if (ticket !== generation || S.current?.id !== id) return;
  if (info.running) { state(i18nText("正在连接 {p0}…", { p0: String(info.browser) }), "正在连接浏览器…"); await connect(id, ticket, info); }
  else state(i18nText("浏览器未启动 · 点击启动后继续上次的登录状态"));
 } catch (e) { if (ticket === generation) problem((e as Error).message); }
 finally { if (ticket === generation) { busy = false; controls(); } }
}

async function startBrowser(url = "") {
 if (pending() || !S.current) return;
 const id = S.current.id;
 const ticket = generation;
 busy = true; controls();
 state(i18nText("正在启动浏览器…"), connected ? "正在打开网页…" : "正在启动浏览器…");
 try {
  const info = await api<BrowserInfo>(`/sessions/${id}/browser`, {method:"POST",body:JSON.stringify({url})});
  if (ticket !== generation || S.current?.id !== id || S.tab !== "browser") return;
  state(`${info.browser || "Chrome"} · ${info.proxy ? i18nText("账号代理出口") : i18nText("服务器出口")}`, connected ? "已连接" : "正在连接浏览器…");
  if (!desktop) await connect(id, ticket, info);
 } catch (e) {
  if (ticket === generation) {
   const message = (e as Error).message;
   problem(message);
   if (!compactLayout.matches) toast(message, true);
  }
 } finally { if (ticket === generation) { busy = false; controls(); } }
}

export function initRemoteBrowser() {
 controller?.abort();
 controller = new AbortController();
 const {signal} = controller;
 const renderAddress = () => setAttr($("browser-url"), "placeholder", compactLayout.matches ? "网页地址" : "输入网址，在新标签页打开");
 renderAddress();
 compactLayout.addEventListener("change", renderAddress, {signal});
 for (const button of document.querySelectorAll<HTMLButtonElement>("[data-browser-brand]")) {
  if (!button.querySelector(".agent-ico")) button.prepend(agentIcon(button.dataset.browserBrand!, 16));
 }
 const quality = $<HTMLSelectElement>("browser-quality");
 let saved = "smooth";
 try { saved = localStorage.getItem("agentbox_browser_quality") || saved; } catch { /* private mode */ }
 setSelectValue(quality, qualityModes[saved] ? saved : "smooth");
 enhanceSelects($("tab-browser"));
 quality.addEventListener("change", () => {
  if (desktop) applyQuality(desktop);
  try { localStorage.setItem("agentbox_browser_quality", quality.value); } catch { /* private mode */ }
 }, {signal});
 bus.addEventListener("view-changed", () => {
  if (S.view !== "work") browserDisconnect();
  else if (S.current && S.tab === "browser") void showBrowser();
 }, {signal});
 $("browser-start").addEventListener("click", () => void startBrowser(), {signal});
 $("browser-launch").addEventListener("click", () => void startBrowser(), {signal});
 $("browser-address").addEventListener("submit", e => {
  e.preventDefault();
  const input = $<HTMLInputElement>("browser-url");
  let url = input.value.trim();
  if (!url) return;
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = "https://" + url;
  try {
   const parsed = new URL(url);
   if (!["http:","https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { toast(i18nText("请输入有效的 HTTP / HTTPS 地址"), true); return; }
  void startBrowser(url);
 }, {signal});
 for (const button of document.querySelectorAll<HTMLButtonElement>("[data-browser-url]")) {
  button.addEventListener("click", () => void startBrowser(button.dataset.browserUrl), {signal});
 }
 const stop = async () => {
  if (!S.current || busy) return;
  const id = S.current.id;
  browserDisconnect(); const ticket = generation;
  busy = true; controls(); state(i18nText("正在关闭浏览器…"), "正在关闭浏览器…");
  try {
   await api(`/sessions/${id}/browser`, {method:"DELETE"});
   if (ticket === generation) state(i18nText("浏览器已关闭 · 登录状态已保留"));
  } catch (e) { if (ticket === generation) problem((e as Error).message); }
  finally { if (ticket === generation) { busy = false; controls(); } }
 };
 const fullscreen = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $("tab-browser").requestFullscreen(); }
  catch { toast(i18nText("当前浏览器不支持全屏"), true); }
 };
 $("browser-stop").addEventListener("click", stop, {signal});
 $("browser-fullscreen").addEventListener("click", fullscreen, {signal});
 const more = $<HTMLButtonElement>("browser-more");
 more.addEventListener("click", () => {
  if (!connected || pending()) return;
  const clipboard = $<HTMLDetailsElement>("browser-clipboard-panel");
  openMenu(more, [
   ...Array.from(quality.options, option => ({
    label: i18nText("画质：{p0}", {p0:option.textContent}),
    icon: option.selected ? "check" as const : "sliders" as const,
    run: () => {
     setSelectValue(quality, option.value);
     quality.dispatchEvent(new Event("change", {bubbles:true}));
     more.focus({preventScroll:true});
    },
   })),
   {label:i18nText(document.fullscreenElement ? "退出全屏" : "全屏"), icon:"expand", sep:true, run:fullscreen},
   {label:i18nText("剪贴板"), icon:"paste", run:() => {
    clipboard.open = !clipboard.open;
    (clipboard.open ? clipboard.querySelector("summary") : more)?.focus({preventScroll:true});
   }},
   {label:i18nText("关闭浏览器"), icon:"close", danger:true, run:stop},
  ]);
 }, {signal});
 $("browser-copy").addEventListener("click", async () => {
  const id = S.current?.id, ticket = generation; if (!id || !connected) return;
  try {
   const result = await api<{text:string}>(`/sessions/${id}/browser/clipboard`);
   if (ticket === generation) $<HTMLTextAreaElement>("browser-clipboard").value = result.text;
  } catch (e) { toast((e as Error).message, true); }
 }, {signal});
 $("browser-paste").addEventListener("click", async () => {
  const view = desktop, id = S.current?.id; if (!view || !connected || !id) return;
  try {
   await api(`/sessions/${id}/browser/clipboard`, {method:"POST",body:JSON.stringify({text:$<HTMLTextAreaElement>("browser-clipboard").value})});
  } catch (e) { toast((e as Error).message, true); return; }
  if (desktop !== view) return;
  view.focus();
  // Deliberate click only: never read the local clipboard automatically.
  view.sendKey(0xffe3, "ControlLeft", true);
  view.sendKey(0x76, "KeyV");
  view.sendKey(0xffe3, "ControlLeft", false);
 }, {signal});
 return () => { controller?.abort(); controller = null; browserDisconnect(); $<HTMLTextAreaElement>("browser-clipboard").value = ""; };
}
