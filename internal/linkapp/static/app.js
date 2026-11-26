/* abox-link: pairing, local folders and connection status. */
"use strict";

import { createI18n, languages } from "./i18n-core.js";
import { createFileManager } from "./file-manager.js";
import en from "./locales/en.js";
import zhTW from "./locales/zh-TW.js";
import ru from "./locales/ru.js";

const i18n = createI18n({ storageKey: "abox_link_language", catalogs: { en, "zh-TW": zhTW, ru } });
const tr = (source, params) => i18n.t(source, params);
// Only explicitly marked interface text is translated. Local paths, connection logs,
// pairing codes and server diagnostics never enter this catalog.
const staticSources = new WeakMap();
const translatedAttributes = ["aria-label", "title", "placeholder"];
function translateMarkers(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    if (!staticSources.has(el)) staticSources.set(el, el.textContent.trim());
    const text = tr(staticSources.get(el));
    if (el.dataset.icon) actionLabel(el, text, el.dataset.icon);
    else el.textContent = text;
  }
  for (const attr of translatedAttributes) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, tr(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}
function localizedAttribute(el, attr, source) {
  el.setAttribute(`data-i18n-${attr}`, source);
  el.setAttribute(attr, tr(source));
}


const $ = (id) => document.getElementById(id);

// Prevent a file dropped from Explorer from replacing the desktop panel.
for (const event of ["dragover", "drop"]) {
  document.addEventListener(event, e => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

// This panel is embedded in its own binary, so its small icon set is standalone.
const actionIcons = {
  "left": "M19 12H5m6 6-6-6 6-6",
  "right": "M5 12h14m-6-6 6 6-6 6",
  "folderPlus": "M3 7v12h18V8H11L9 5H3v2m9 4v5m-2.5-2.5h5",
  "link": "m10 13 4-4M8 16l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 8a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1",
  "plus": "M12 5v14M5 12h14",
  "play": "M6.5 3.5 20 12 6.5 20.5Z",
  "stop": "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  "trash": "M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M5.5 6l1 14.5h11L18.5 6",
  "unlink": "m9 15-2 2a3.5 3.5 0 0 1-5-5l2-2m11-1 2-2a3.5 3.5 0 0 1 5 5l-2 2M3 3l18 18M9 3v3M3 9h3m12 0h3m-12 9v3",
};
function actionLabel(button, label, icon) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const attrs = {
    viewBox: "0 0 24 24", width: "16", height: "16", fill: "none",
    stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", actionIcons[icon]);
  svg.append(path);
  button.replaceChildren(svg, document.createTextNode(label));
}

/* 面板 API：X-Abox-Panel 头是防跨站的凭据——浏览器不会让外站页面带上它。 */
function panelErrorMessage(message) {
  if (message.startsWith("配对失败：")) {
    return tr("配对失败：{detail}", { detail: tr(message.slice("配对失败：".length)) });
  }
  for (const prefix of ["保存配置失败：", "配置文件损坏: "]) {
    if (message.startsWith(prefix)) return tr(prefix + "{detail}", { detail: message.slice(prefix.length) });
  }
  const connection = /^连接 (\S+) 失败：([\s\S]*)$/.exec(message);
  if (connection) return tr("连接 {host} 失败：{detail}", { host: connection[1], detail: connection[2] });
  return tr(message);
}

class PanelAPIError extends Error {
  constructor(source) {
    super(panelErrorMessage(source));
    this.source = source;
  }
}

let stateRevision = 0;
let pendingWrites = 0;
async function api(path, body) {
  const writing = body !== undefined;
  if (writing) {
    stateRevision++;
    pendingWrites++;
  }
  try {
    const res = await fetch("/api" + path, {
      method: writing ? "POST" : "GET",
      headers: { "X-Abox-Panel": "1", "Content-Type": "application/json" },
      body: writing ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PanelAPIError(typeof data.error === "string" ? data.error : res.statusText);
    return data;
  } finally {
    if (writing) pendingWrites--;
  }
}

let state = null;   // 服务端权威状态
let logSeq = 0;
let foldersKey = "";
let folderSaving = false;

/* ---- 渲染 ---- */

const ST = {
  online:      { cls: "on",   title: "设备已连接",   btn: "断开" },
  connecting:  { cls: "busy", title: "正在连接…",  btn: "断开" },
  auth_failed: { cls: "bad",  title: "凭证已失效", btn: "连接" },
  stopped:     { cls: "",     title: "未连接",     btn: "连接" },
};

function render() {
  if (!state) return;
  const paired = state.paired;

  $("card-pair").classList.toggle("hidden", paired);
  $("card-status").classList.toggle("hidden", !paired);
  $("panel-body").classList.toggle("hidden", !paired);
  $("hdr-acct").textContent = paired ? state.user + " @ " + hostOf(state.server) : "";
  $("hdr-version").textContent = state.version || "";

  const st = state.status || { state: "stopped" };
  const look = ST[st.state] || ST.stopped;
  $("hdr-dot").className = "dot " + look.cls;
  $("wire").className = "wire " + look.cls; // 电路两条腿与三个节点全按状态取色
  $("st-title").textContent = tr(look.title);
  $("st-sub").textContent = subtitle(st);
  actionLabel($("btn-toggle"), tr(look.btn), look.btn === "断开" ? "stop" : "play");

  renderFolders();
  renderOptions();
  manager.update(state);

}

function subtitle(st) {
  if (st.state === "online") {
    const parts = [tr("已连接 {duration}", { duration: uptime(Date.now() - st.since) })];
    if (typeof st.ping_ms === "number" && st.ping_ms >= 0) {
      parts.push(tr("延迟 {latency}", { latency: fmtLatency(st.ping_ms) }));
    }
    return parts.join(" · ");
  }
  if (st.detail) return st.detail;
  return state.server ? hostOf(state.server) : "";
}

function removeBtn(onClick) {
  const b = document.createElement("button");
  b.type = "button";
  actionLabel(b, "", "trash");
  localizedAttribute(b, "title", "删除");
  b.addEventListener("click", onClick);
  return b;
}

function renderFolders() {
  const folders = state.folders || [];
  const key = JSON.stringify(folders);
  if (key === foldersKey) return;
  foldersKey = key;
  const list = $("local-folder-list");
  list.replaceChildren();
  for (const folder of folders) {
    const row = document.createElement("div");
    row.className = "rule local-folder-row";
    const text = document.createElement("span");
    text.textContent = folder.name + " · " + folder.path;
    const remove = removeBtn(() => void saveFolder(remove, { id: folder.id }));
    localizedAttribute(remove, "aria-label", "移除文件夹");
    row.append(text, remove);
    list.append(row);
  }
}

async function saveFolder(button, body) {
  if (folderSaving) return;
  await withBusy(button, async () => {
    folderSaving = true;
    try {
      state = await api("/folders", body);
      if (!body.id && $("local-folder-name").value === body.name && $("local-folder-path").value === body.path) {
        $("local-folder-form").reset();
      }
      render();
    } catch (error) {
      toast(error.message, true);
    } finally {
      folderSaving = false;
    }
  });
}

$("local-folder-form").addEventListener("submit", event => {
  event.preventDefault();
  void saveFolder($("local-folder-add"), { name: $("local-folder-name").value, path: $("local-folder-path").value });
});

function renderOptions() {
  $("opt-auto").checked = state.auto_connect;
  $("opt-insecure").checked = state.insecure;
  const boot = state.autostart || {};
  $("opt-boot").checked = !!boot.installed;
  $("opt-boot").disabled = !boot.supported;
  $("boot-detail").textContent = boot.detail || "";
}

/* ---- 日志 ---- */

async function pollLogs() {
  let data;
  try {
    data = await api("/logs?since=" + logSeq);
  } catch (_) {
    return;
  }
  if (!data.lines.length) return;
  const box = $("log");
  const stuck = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  for (const line of data.lines) {
    const div = document.createElement("div");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(line.time).toLocaleTimeString(i18n.locale, { hour12: false });
    div.append(t, document.createTextNode(line.text));
    box.appendChild(div);
  }
  while (box.childElementCount > 500) box.removeChild(box.firstChild);
  if (stuck) box.scrollTop = box.scrollHeight;
  logSeq = data.latest;
}

/* ---- 事件 ---- */

$("btn-pair").addEventListener("click", async () => {
  const code = $("pair-code").value.trim();
  pairErrorSource = "";
  $("pair-err").textContent = "";
  if (!code) {
    pairErrorSource = "请先粘贴配对码";
    $("pair-err").textContent = tr(pairErrorSource);
    return;
  }
  await withBusy($("btn-pair"), async () => {
    try {
      state = await api("/pair", { code, insecure: $("pair-insecure").checked });
      $("pair-code").value = "";
      render();
      toastUI("配对成功，可以添加本机文件夹");
    } catch (e) {
      pairErrorSource = e instanceof PanelAPIError ? e.source : "";
      $("pair-err").textContent = e.message;
    }
  });
});

$("btn-toggle").addEventListener("click", async () => {
  const running = state.running;
  await withBusy($("btn-toggle"), async () => {
    try {
      state = await api(running ? "/stop" : "/start", {});
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
});

for (const id of ["opt-auto", "opt-insecure"]) {
  const input = $(id);
  input.addEventListener("change", () => withBusy(input, async () => {
    try {
      state = await api("/config", id === "opt-auto" ? { auto_connect: input.checked } : { insecure: input.checked });
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }));
}

$("opt-boot").addEventListener("change", async (e) => {
  const enable = e.target.checked;
  try {
    state = await api("/autostart", { enable });
    render();
    toastUI(enable ? "已设置开机自启" : "已取消开机自启");
  } catch (err) {
    toast(err.message, true);
    await refresh();
  }
});

$("btn-unpair").addEventListener("click", async () => {
  if (!confirm(tr("解除配对并移除共享文件夹？"))) return;
  try {
    state = await api("/unpair", {});

    $("local-folder-form").reset();
    render();
  } catch (e) {
    toast(e.message, true);
  }
});

/* ---- 工具 ---- */

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return url || ""; }
}

/* 延迟展示：<1ms 收成「<1」，个位数保留一位小数，其余取整 */
function fmtLatency(ms) {
  if (ms < 1) return "<1 ms";
  if (ms < 10) return ms.toFixed(1) + " ms";
  return Math.round(ms) + " ms";
}

function uptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return tr("{count} 秒", { count: s });
  if (s < 3600) return tr("{count} 分钟", { count: Math.floor(s / 60) });
  if (s < 86400) return tr("{hours} 小时 {minutes} 分", { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) });
  return tr("{days} 天 {hours} 小时", { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600) });
}

async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.setAttribute("aria-busy", "true");
  try { await fn(); } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.removeAttribute("aria-busy");
  }
}

let toastTimer = 0;
let toastSource = "";
let pairErrorSource = "";
function toastUI(source) {
  toast(tr(source));
  toastSource = source;
}
function toast(msg, bad) {
  toastSource = "";
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

async function refresh() {
  if (pendingWrites) return;
  const revision = stateRevision;
  try {
    const snapshot = await api("/state");
    if (revision !== stateRevision) return;
    state = snapshot;
    render();
  } catch (_) { /* 面板进程没了，下一轮再试 */ }
}

const manager = createFileManager({ tr, locale: () => i18n.locale, errorMessage: panelErrorMessage, toast, pickManualFolder: () => { $("panel-body").open = true; $("local-folder-path").focus(); } });

const languageSelect = $("interface-language");
for (const language of [{ value: "system", label: "跟随系统" }, ...languages.filter(language => language.value !== "system")]) {
  const option = document.createElement("option");
  option.value = language.value;
  option.textContent = language.label;
  if (language.value === "system") option.setAttribute("data-i18n", "");
  languageSelect.append(option);
}
function renderLanguage() {
  document.documentElement.lang = i18n.locale;
  languageSelect.value = i18n.preference;
  translateMarkers();
  manager.translate();
  // renderRules keeps its existing DOM when rule values have not changed.
  // Switching language must never discard an unsaved folder or cursor.
  render();
  if (pairErrorSource) $("pair-err").textContent = panelErrorMessage(pairErrorSource);
  if (toastSource) $("toast").textContent = tr(toastSource);
}
languageSelect.addEventListener("change", () => i18n.setLanguage(languageSelect.value));
i18n.subscribe(renderLanguage);
renderLanguage();

/* 在线时刷得勤一点，让「连接中 → 在线」和运行时长跟得上 */
setInterval(() => {
  refresh();
  pollLogs();
}, 2000);

await refresh();
await pollLogs();
