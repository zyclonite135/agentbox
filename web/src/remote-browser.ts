import { setAttr, setText, t as i18nText } from "./i18n.js";
import { svgIcon } from "./icons.js";
import { S, bus } from "./state.js";
import { api, wsURL } from "./api.js";
import { enhanceSelects, setSelectValue } from "./select.js";
import { closeMenu, openMenu } from "./menu.js";
import { setTip } from "./tip.js";
import { setupBrowserClipboard } from "./browser-clipboard.js";
import { $, toast } from "./util.js";
import type { BrowserInfo } from "./types.js";

type Desktop = EventTarget & {
 disconnect(): void; focus(): void;
 sendKey(keysym: number, code: string, down?: boolean): void;
 offerClipboard(provider: () => Promise<string | null>): Promise<boolean>;
 deferInput(ready: Promise<void>): void;
 withdrawClipboardOffer(): void;
 scaleViewport: boolean; resizeSession: boolean; qualityLevel: number; compressionLevel: number;
};
let desktop: Desktop | null = null;
let nativeClipboard = false;
let generation = 0;
let controller: AbortController | null = null;
let connected = false;
let busy = false;
let connectTimer = 0;
type BrowserTab = {id: string; title: string; url: string; favicon?: string};
type BrowserNavigation = {active: string; tabs: BrowserTab[]; back: boolean; forward: boolean};
type NavigationCommand = {operation: "navigate" | "back" | "forward" | "reload" | "select" | "new" | "close"; url?: string; tab?: string};
let navigation: BrowserNavigation | null = null;
let navigationId = "";
let navigationTimer = 0;
let navigationBusy = false;
let navigationReading = false;
let navigationVersion = 0;
const pendingFavicons = new Map<string, Promise<BrowserNavigation | null>>();
type TabCard = {
 item: HTMLDivElement; select: HTMLButtonElement; close: HTMLButtonElement;
 label: HTMLSpanElement; icon: HTMLSpanElement; title?: string;
 favicon?: {url: string; attempts: number; nextRead: number};
};
const tabCards = new Map<string, TabCard>();
let shownActiveTab = "";
let editingAddress = false;
let fullscreenOwner = "";
let fullscreenChanges = Promise.resolve();
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

function navigationPath(id: string) { return `/sessions/${encodeURIComponent(id)}/browser/navigation`; }

function readFavicons(id: string, tabs: BrowserTab[]) {
 const icons = new Map<string, Promise<string | undefined>>();
 const pages = tabs.filter(tab => /^https?:\/\//.test(tab.url));
 const batchSize = 24;
 for (let offset = 0; offset < pages.length; offset += batchSize) {
  const batch = pages.slice(offset, offset + batchSize);
  const key = JSON.stringify([generation, id, batch.map(tab => [tab.id, tab.url])]);
  let response = pendingFavicons.get(key);
  if (!response) {
   const query = new URLSearchParams(batch.map(tab => ["favicon", tab.id]));
   response = api<BrowserNavigation>(navigationPath(id) + "?" + query)
    .catch(() => null)
    .finally(() => pendingFavicons.delete(key));
   pendingFavicons.set(key, response);
  }
  for (const tab of batch) icons.set(tab.id, response.then(result => {
   const icon = result?.tabs?.find(entry => entry.id === tab.id && entry.url === tab.url)?.favicon;
   if (icon && icon.length <= 2732 && /^[A-Za-z0-9+/]+={0,2}$/.test(icon)) return "data:image/png;base64," + icon;
  }));
 }
 return icons;
}

function renderAddressHint() {
 setAttr($("browser-url"), "placeholder", navigationId || compactLayout.matches ? "网页地址" : "输入网址，在新标签页打开");
}

function createTabCard(id: string): TabCard {
 const item = document.createElement("div");
 item.className = "browser-tab-card";
 const select = document.createElement("button");
 select.type = "button";
 select.className = "browser-tab-select";
 const icon = document.createElement("span");
 icon.className = "browser-tab-icon";
 icon.setAttribute("aria-hidden", "true");
 const label = document.createElement("span");
 label.className = "browser-tab-title";
 select.append(icon, label);
 select.addEventListener("click", () => {
  if (navigation?.active !== id) void updateNavigation({operation:"select", tab:id});
 });
 const close = document.createElement("button");
 close.type = "button";
 close.className = "browser-tab-close";
 close.append(svgIcon("close", 14));
 close.addEventListener("click", () => void updateNavigation({operation:"close", tab:id}));
 item.append(select, close);
 return {item, select, close, label, icon};
}

function revealActiveTab() {
 const list = $("browser-tab-list");
 const card = tabCards.get(shownActiveTab)?.item;
 if (!card || !list.clientWidth) return;
 const view = list.getBoundingClientRect();
 const tab = card.getBoundingClientRect();
 list.scrollLeft += Math.min(0, tab.left - view.left) || Math.max(0, tab.right - view.right);
}

function renderTabStrip(available: boolean) {
 const strip = $("browser-tab-strip");
 const picker = $("browser-tabs");
 const focused = document.activeElement;
 const pickerOpen = picker.getAttribute("aria-expanded") === "true";
 const pickerFocused = focused === picker || pickerOpen;
 strip.hidden = !available || compactLayout.matches;
 picker.hidden = available && !compactLayout.matches;
 if (picker.hidden && pickerOpen) closeMenu();
 const list = $("browser-tab-list");
 if (!available) {
  if (tabCards.size) list.replaceChildren();
  tabCards.clear();
  shownActiveTab = "";
 }
 if (strip.hidden) {
  if (available && strip.contains(focused)) {
   (picker.matches(":enabled") ? picker : $("browser-url")).focus({preventScroll:true});
  }
  return;
 }
 const tabs = navigation?.tabs ?? [];
 const active = navigation?.active ?? "";
 const live = new Set(tabs.map(tab => tab.id));
 const focusedCard = focused?.closest(".browser-tab-card");
 const nextCard = focusedCard?.nextElementSibling;
 const previousCard = focusedCard?.previousElementSibling;
 for (const [id, card] of tabCards) {
  if (live.has(id)) continue;
  card.item.remove();
  tabCards.delete(id);
 }
 const iconsToRead: BrowserTab[] = [];
 for (const tab of tabs) {
  let card = tabCards.get(tab.id);
  if (!card) {
   card = createTabCard(tab.id);
   tabCards.set(tab.id, card);
   list.append(card.item);
  }
  const title = (tab.title || tab.url) === "about:blank" ? "" : tab.title || tab.url;
  if (card.title !== title) {
   card.title = title;
   if (title) {
    card.label.textContent = title;
    card.select.title = title;
    setAttr(card.close, "aria-label", "关闭标签页：{p0}", {p0:title});
   } else {
    setText(card.label, "新建标签页");
    setAttr(card.select, "title", "新建标签页");
    setAttr(card.close, "aria-label", "关闭标签页");
   }
  }
  card.item.toggleAttribute("data-active", tab.id === active);
  card.select.setAttribute("aria-pressed", String(tab.id === active));
  card.select.setAttribute("aria-disabled", String(navigationBusy));
  card.close.setAttribute("aria-disabled", String(navigationBusy));
  card.close.disabled = tabs.length < 2;
  if (card.favicon?.url !== tab.url) {
   card.icon.replaceChildren(svgIcon("globe", 15));
   card.favicon = {url:tab.url, attempts:0, nextRead:0};
  }
  if (/^https?:\/\//.test(tab.url) && card.favicon.nextRead <= Date.now()) iconsToRead.push(tab);
 }
 if (iconsToRead.length) {
  const icons = readFavicons(navigationId, iconsToRead);
  for (const tab of iconsToRead) {
   const card = tabCards.get(tab.id)!;
   const lookup = card.favicon!;
   lookup.nextRead = Infinity;
   lookup.attempts++;
   void icons.get(tab.id)?.then(src => {
    if (tabCards.get(tab.id) !== card || card.favicon !== lookup) return;
    if (!src) {
     if (lookup.attempts < 2) lookup.nextRead = Date.now() + 1800;
     return;
    }
    const image = new Image(15, 15);
    image.alt = "";
    image.addEventListener("load", () => {
     if (card.favicon === lookup) card.icon.replaceChildren(image);
    }, {once:true});
    image.src = src;
   });
  }
 }
 const newTab = $<HTMLButtonElement>("browser-new-tab");
 newTab.disabled = navigationBusy || !navigation;
 const activeChanged = shownActiveTab !== active;
 if (pickerFocused || (focusedCard && !list.contains(focusedCard))) {
  const neighbor = !activeChanged && !pickerFocused ? [nextCard, previousCard].find(card => card?.isConnected) : undefined;
  const button = neighbor?.querySelector<HTMLButtonElement>(".browser-tab-select");
  (button || tabCards.get(active)?.select || (newTab.disabled ? $("browser-url") : newTab)).focus();
 }
 if (activeChanged) {
  shownActiveTab = active;
  revealActiveTab();
 }
}

function renderNavigation() {
 const available = connected && !!navigationId;
 $("browser-nav").hidden = !available;
 const addressDisabled = pending() || navigationBusy;
 $<HTMLButtonElement>("browser-open").disabled = addressDisabled;
 const disabled = navigationBusy || !navigation;
 $<HTMLButtonElement>("browser-back").disabled = disabled || !navigation?.back;
 $<HTMLButtonElement>("browser-forward").disabled = disabled || !navigation?.forward;
 $<HTMLButtonElement>("browser-reload").disabled = disabled || !navigation?.active;
 $<HTMLButtonElement>("browser-tabs").disabled = disabled;
 renderTabStrip(available);
 if (!available || !navigation || navigationBusy || editingAddress) return;
 const url = navigation.tabs.find(tab => tab.id === navigation?.active)?.url ?? "";
 $<HTMLInputElement>("browser-url").value = /^https?:\/\//.test(url) ? url : "";
}

async function updateNavigation(command?: NavigationCommand) {
 const id = navigationId;
 if (!id || !connected || navigationBusy || (!command && navigationReading)) return;
 const currentGeneration = generation;
 const ticket = ++navigationVersion;
 const input = $<HTMLInputElement>("browser-url");
 const closing = command?.operation === "close" ? {active:navigation?.active, draft:input.value} : undefined;
 if (command) {
  navigationBusy = true;
  if (["navigate", "select", "new"].includes(command.operation)) editingAddress = false;
 } else navigationReading = true;
 renderNavigation();
 try {
  const request = command ? {method:"POST", body:JSON.stringify(command)} : undefined;
  const result = await api<BrowserNavigation>(navigationPath(id), request);
  if (ticket === navigationVersion && Array.isArray(result.tabs)) {
   if (closing && closing.active !== result.active && closing.draft === input.value) editingAddress = false;
   navigation = result;
  }
 } catch (err) {
  if (command && ticket === navigationVersion) toast((err as Error).message, true);
 } finally {
  if (id === navigationId && generation === currentGeneration) {
   if (command && ticket === navigationVersion) navigationBusy = false;
   if (!command) navigationReading = false;
   renderNavigation();
  }
 }
}

function queueFullscreen(id: string, enabled: boolean) {
 fullscreenChanges = fullscreenChanges.then(async () => {
  try {
   await api(navigationPath(id), {method:"POST", keepalive:!enabled, body:JSON.stringify({operation:"fullscreen", enabled})});
  } catch (err) {
   if (id === navigationId && enabled) toast((err as Error).message, true);
  }
 });
}

function syncFullscreen() {
 const enabled = document.fullscreenElement === $("tab-browser");
 $("browser-fullscreen").setAttribute("aria-pressed", String(enabled));
 if (enabled && navigationId && !fullscreenOwner) {
  fullscreenOwner = navigationId;
  queueFullscreen(fullscreenOwner, true);
 } else if (!enabled && fullscreenOwner) {
  queueFullscreen(fullscreenOwner, false);
  fullscreenOwner = "";
 }
}

function state(text: string, compact = "", error = "") {
 $("browser-state").textContent = text;
 setTip($("browser-connection"), text);
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
 const status = !$("browser-error-details").classList.contains("hidden") ? "error" :
  pending() ? "busy" : connected ? "connected" : "idle";
 $("browser-dot").dataset.state = status;
 $("browser-connection").dataset.state = status;
}
function setClipboardFallback(open: boolean) {
 const panel = $<HTMLDetailsElement>("browser-clipboard-panel");
 if (open && !compactLayout.matches) {
  panel.setAttribute("data-copy-fallback", "");
  panel.open = true;
  return true;
 }
 if (!open && panel.hasAttribute("data-copy-fallback")) {
  panel.removeAttribute("data-copy-fallback");
  panel.open = false;
 }
 return false;
}
function controls() {
 updateDot();
 const pane = $("tab-browser");
 pane.toggleAttribute("data-connected", connected);
 const more = $<HTMLButtonElement>("browser-more");
 const start = $<HTMLButtonElement>("browser-start");
 const stop = $<HTMLButtonElement>("browser-stop");
 const disabled = pending();
 more.disabled = disabled;
 if (!connected && compactLayout.matches) {
  if (more.getAttribute("aria-expanded") === "true") closeMenu();
  $<HTMLDetailsElement>("browser-clipboard-panel").open = false;
  if (document.fullscreenElement === pane) void document.exitFullscreen().catch(() => {});
 }
 // 同一时刻只露一个：没连上时「启动浏览器」，连上后「关闭浏览器」
 const focused = document.activeElement;
 const hidden = connected ? start : stop;
 if (!compactLayout.matches && (focused === hidden || (disabled && (focused === start || focused === stop)))) {
  $("browser-connection").focus({preventScroll:true});
 }
 start.classList.toggle("hidden", connected);
 stop.classList.toggle("hidden", !connected);
 start.disabled = disabled;
 stop.disabled = disabled;
 $<HTMLButtonElement>("browser-launch").disabled = disabled;
 $<HTMLButtonElement>("browser-paste").disabled = !connected;
 $<HTMLButtonElement>("browser-copy").disabled = !connected;
 renderNavigation();
}
function resetDesktop(closeTransport = false) {
 window.clearTimeout(connectTimer);
 window.clearInterval(navigationTimer);
 if ($("browser-tabs").getAttribute("aria-expanded") === "true") closeMenu();
 setClipboardFallback(false);
 $<HTMLTextAreaElement>("browser-clipboard").value = "";
 navigationVersion++;
 navigation = null; navigationId = "";
 navigationBusy = false; navigationReading = false; editingAddress = false;
 renderAddressHint();
 if (fullscreenOwner) {
  queueFullscreen(fullscreenOwner, false);
  fullscreenOwner = "";
 }
 if (document.fullscreenElement === $("tab-browser")) void document.exitFullscreen().catch(() => {});
 const old = desktop;
 desktop = null; connected = false; nativeClipboard = false;
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
 nativeClipboard = !!info.clipboard_offer && !!info.clipboard_guard;
 controls();
 view.scaleViewport = true;
 // Older browser images keep proportional scaling if they cannot resize.
 view.resizeSession = true;
 applyQuality(view);
 view.addEventListener("connect", () => {
  if (desktop !== view) return;
  window.clearTimeout(connectTimer);
  connected = true; state(i18nText("已连接 · {p0} · {p1}", { p0: String(info.browser || "Chrome"), p1: String(info.proxy ? i18nText("账号代理出口") : i18nText("服务器出口")) }), "已连接");
  if (info.navigation) {
   navigationId = id;
   renderAddressHint();
   syncFullscreen();
   void updateNavigation();
   navigationTimer = window.setInterval(() => {
    if (!document.hidden) void updateNavigation();
   }, 2000);
  }
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
 setupBrowserClipboard($("browser-screen"), () => {
  const view = desktop, id = S.current?.id, ticket = generation;
  const tab = navigation?.active;
  const active = () => connected && desktop === view && S.current?.id === id && S.tab === "browser"
   && ticket === generation && (!tab || tab === navigation?.active) && !document.hidden && document.hasFocus();
  return view && id && active() ? {id, view, current:active, nativeClipboard} : null;
 }, signal, setClipboardFallback);
 const clipboard = $<HTMLDetailsElement>("browser-clipboard-panel");
 clipboard.addEventListener("toggle", () => {
  if (!clipboard.open) clipboard.removeAttribute("data-copy-fallback");
 }, {signal});
 renderAddressHint();
 compactLayout.addEventListener("change", () => {
  setClipboardFallback(false);
  renderAddressHint();
  renderNavigation();
 }, {signal});
 const tabListObserver = new ResizeObserver(revealActiveTab);
 tabListObserver.observe($("browser-tab-list"));
 signal.addEventListener("abort", () => tabListObserver.disconnect(), {once:true});
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
 $("browser-url").addEventListener("input", () => { editingAddress = true; }, {signal});
 $("browser-url").addEventListener("keydown", event => {
  if (event.key === "Escape" && editingAddress && navigationId) {
   editingAddress = false;
   renderNavigation();
  }
 }, {signal});
 for (const operation of ["back", "forward", "reload"] as const) {
  $(`browser-${operation}`).addEventListener("click", () => void updateNavigation({operation}), {signal});
 }
 $("browser-new-tab").addEventListener("click", () => void updateNavigation({operation:"new"}), {signal});
 const tabPicker = $("browser-tabs");
 tabPicker.addEventListener("click", () => {
  if (!navigation) return;
  if (tabPicker.getAttribute("aria-expanded") === "true") {
   closeMenu();
   return;
  }
  const favicons = readFavicons(navigationId, navigation.tabs);
  const active = navigation.active;
  openMenu(tabPicker, [
   ...navigation.tabs.map(tab => ({
    label: tab.title || tab.url || i18nText("新建标签页"),
    icon: "globe" as const,
    checked: tab.id === active,
    image: favicons.get(tab.id),
    run: () => void updateNavigation({operation:"select", tab:tab.id}),
   })),
   {label:i18nText("新建标签页"), icon:"plus", sep:true, run:() => void updateNavigation({operation:"new"})},
   {label:i18nText("关闭当前标签页"), icon:"close", disabled:navigation.tabs.length < 2 || !active,
    run:() => void updateNavigation({operation:"close", tab:active})},
  ]);
 }, {signal});
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
  if (navigationId) void updateNavigation({operation:"navigate", url});
  else void startBrowser(url);
 }, {signal});
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
 document.addEventListener("fullscreenchange", syncFullscreen, {signal});
 window.addEventListener("pagehide", () => {
  if (fullscreenOwner) {
   void api(navigationPath(fullscreenOwner), {method:"POST", keepalive:true,
    body:JSON.stringify({operation:"fullscreen", enabled:false})}).catch(() => {});
   fullscreenOwner = "";
  }
 }, {signal});
 $("browser-stop").addEventListener("click", stop, {signal});
 $("browser-fullscreen").addEventListener("click", fullscreen, {signal});
 const more = $<HTMLButtonElement>("browser-more");
 more.addEventListener("click", () => {
  if (!connected || pending()) return;
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
 return () => { controller?.abort(); controller = null; browserDisconnect(); };
}
