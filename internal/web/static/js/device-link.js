import { setText, setTextRender, t as i18nText } from "./i18n.js";
import { skelBar } from "./skeleton.js";
/* Device pairing and shared-folder connection status. */
"use strict";
import { buttonLabel } from "./icons.js";
import { S, bus, emit } from "./state.js";
import { $, toast } from "./util.js";
import { api } from "./api.js";
import { showView } from "./shell.js";
import { setTip } from "./tip.js";
let latestStatus = null; // GET /api/device-link/status 缓存
let lastFetch = 0;
let statusRequest = 0;
let pageVisit = 0;
const onPage = () => S.view === "device-link";
async function refreshStatus(force) {
    if (!S.token || (!force && Date.now() - lastFetch < 15000))
        return;
    lastFetch = Date.now();
    try {
        const request = ++statusRequest;
        const status = await api("/device-link/status");
        if (request !== statusRequest)
            return;
        latestStatus = status;
    }
    catch (_) {
        return; // 网络抖动保持现状
    }
    renderSideItem();
    if (onPage())
        renderPage(); // 停在本页时 5 秒一刷
}
/* ---- 侧栏入口 ---- */
function renderSideItem() {
    const st = latestStatus;
    const btn = $("btn-device-link");
    if (!st || (!st.enabled && S.role !== "admin")) {
        btn.classList.add("hidden");
        return;
    }
    btn.classList.remove("hidden");
    const dot = $("device-link-dot");
    dot.classList.toggle("on", !!st.connected);
    setTextRender($("device-link-text"), () => !st.enabled ? i18nText("未启用") : (st.connected ? i18nText("在线") : i18nText("离线")));
    const label = i18nText("连接设备：") + $("device-link-text").textContent;
    setTip(btn, label);
    btn.setAttribute("aria-label", label);
}
/* ---- 页面 ---- */
function renderPage() {
    const st = latestStatus;
    if (!st)
        return;
    const conn = !!st.connected;
    $("dev-st-dot").classList.toggle("on", conn);
    setTextRender($("dev-st-title"), () => !st.enabled ? i18nText("功能未启用") : (conn ? i18nText("设备已连接") : i18nText("等待接入")));
    const adm = $("dev-admin-online");
    const online = st.online_users;
    adm.classList.toggle("hidden", !(st.enabled && S.role === "admin" && online));
    if (online)
        setTextRender(adm, () => i18nText("已连接设备的用户：") + (online.length ? online.join("、") : i18nText("无")));
    $("dev-off-admin").classList.toggle("hidden", st.enabled);
    $("dev-guide").classList.toggle("hidden", !st.enabled);
}
/* 平台名映射：文件名里带 os-arch，展示成人话 */
function platformLabel(name) {
    const n = name.toLowerCase();
    if (n.includes("windows"))
        return "Windows";
    if (n.includes("darwin"))
        return n.includes("arm64") ? i18nText("macOS（Apple 芯片）") : "macOS（Intel）";
    if (n.includes("linux"))
        return n.includes("arm64") ? "Linux（arm64）" : "Linux";
    return name;
}
async function loadClients() {
    const box = $("dev-dl");
    // 第一次读取时先放几颗按钮大小的骨架，下载区不从空白突然撑开
    if (!box.children.length)
        box.replaceChildren(...Array.from({ length: 5 }, (_, i) => skelBar(7 + (i % 3) + "em", "btn-like")));
    const visit = pageVisit;
    let list = [];
    try {
        list = await api("/device-link/clients");
    }
    catch (_) { }
    if (visit !== pageVisit || !onPage())
        return;
    box.replaceChildren();
    $("dev-dl-empty").classList.toggle("hidden", !!list.length);
    for (const c of list) {
        const a = document.createElement("a");
        a.className = "btn btn-sm dev-dl-btn";
        buttonLabel(a, platformLabel(c.name), "download");
        setTip(a, c.name + " · " + (c.size / 1048576).toFixed(1) + " MB");
        a.href = "/api/device-link/clients/" + encodeURIComponent(c.name) +
            "?token=" + encodeURIComponent(S.token);
        a.setAttribute("download", c.name);
        box.appendChild(a);
    }
}
let pairTimer = 0; // 配对码有效期倒计时
/* 进页面先清掉上次的配对码：码是一次性短时效的，隔一会儿回来那个多半已失效，
 * 留在页面上只会让人以为还能用。 */
function resetPair() {
    clearInterval(pairTimer);
    $("dev-pair").disabled = false;
    $("dev-pair-result").classList.add("hidden");
    $("dev-pair-code").textContent = "";
    setText($("dev-pair-hint"), "10 分钟内有效，只能用一次");
}
export function openDeviceLinkView() {
    pageVisit++;
    showView("device-link");
    resetPair();
    renderPage();
    refreshStatus(true);
    loadClients();
}
$("dev-goto-settings").addEventListener("click", () => {
    S.sec = "security";
    emit("open-settings");
});
/* 配对码：一次性、短时效，粘进 abox-link 控制台即完成接入。
 * 生成后顺手复制到剪贴板，并倒计时显示剩余有效期。 */
$("dev-pair").addEventListener("click", async () => {
    const btn = $("dev-pair");
    btn.disabled = true;
    const visit = pageVisit;
    try {
        const res = await api("/device-link/pair", {
            method: "POST",
            body: JSON.stringify({ origin: location.origin }),
        });
        if (visit !== pageVisit || !onPage())
            return;
        const box = $("dev-pair-code");
        box.textContent = res.code;
        $("dev-pair-result").classList.remove("hidden");
        startPairCountdown(res.expires_in);
        try {
            await navigator.clipboard.writeText(res.code);
            if (visit !== pageVisit || !onPage())
                return;
            toast(i18nText("配对码已复制，粘贴到 abox-link 控制台"));
        }
        catch (_) {
            if (visit === pageVisit && onPage())
                toast(i18nText("配对码已生成，请手动选中复制"));
        }
    }
    catch (e) {
        if (visit === pageVisit && onPage())
            toast(e.message || i18nText("生成配对码失败"), true);
    }
    finally {
        if (visit === pageVisit)
            btn.disabled = false;
    }
});
$("dev-pair-copy").addEventListener("click", async () => {
    const code = $("dev-pair-code").textContent;
    if (!code || $("dev-pair-result").classList.contains("hidden"))
        return;
    try {
        await navigator.clipboard.writeText(code);
        toast(i18nText("配对码已复制，粘贴到 abox-link 控制台"));
    }
    catch (_) {
        toast(i18nText("复制失败，请手动选中配对码复制"), true);
    }
});
function startPairCountdown(seconds) {
    clearInterval(pairTimer);
    const hint = $("dev-pair-hint");
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
        const left = Math.round((deadline - Date.now()) / 1000);
        if (left <= 0) {
            clearInterval(pairTimer);
            setText(hint, "已过期，请重新生成");
            $("dev-pair-result").classList.add("hidden");
            $("dev-pair-code").textContent = "";
            return;
        }
        setTextRender(hint, () => i18nText("剩余 ") + Math.floor(left / 60) + ":" +
            String(left % 60).padStart(2, "0") + i18nText(" 内有效，只能用一次"));
    };
    tick();
    pairTimer = setInterval(tick, 1000);
}
/* 停留在本页期间 5s 一刷，让「等待接入 → 在线」立刻可见 */
setInterval(() => {
    if (onPage())
        refreshStatus(true);
}, 5000);
bus.addEventListener("data-updated", () => refreshStatus(false));
bus.addEventListener("open-device-link", openDeviceLinkView);
bus.addEventListener("view-changed", () => {
    if (onPage())
        return;
    pageVisit++;
    resetPair();
});
bus.addEventListener("signed-out", () => {
    statusRequest++;
    pageVisit++;
    latestStatus = null;
    lastFetch = 0;
    resetPair();
    $("dev-admin-online").classList.add("hidden");
    setText($("dev-admin-online"), "");
    $("dev-dl").replaceChildren();
    renderSideItem();
});
window.addEventListener("agentbox-language-change", renderSideItem);
