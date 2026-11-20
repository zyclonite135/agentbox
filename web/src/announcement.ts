/* 系统通告横幅。管理员在「系统设置 → 系统通告」发布，或发布脚本经
 * `agentbox announce` 写入；登录后所有页面在主区顶部显示。
 *
 * 变更经 usage-live 的同一条推送连接到达（"announcement-changed"），所以登录期间
 * 一直挂着它；推送连不上时每 2 分钟读一次兜底，切回标签页时也读一次。发版类显示
 * 倒计时，到点后显示「正在发版」；新服务启动后服务端把它改成「已升级到 vX」，
 * 10 分钟后不再返回。用户可以收起；重新发布（ID 变了）或升级完成会再出现。 */
import { bus } from "./state.js";
import { api } from "./api.js";
import { i18n, setTextRender, t } from "./i18n.js";
import { usageLiveConnected, watchUsageLive } from "./usage-live.js";
import { $, fmtTime } from "./util.js";
import type { Announcement, AnnouncementView } from "./types.js";

const DISMISSED = "agentbox_announcement_dismissed";
const FALLBACK_POLL = 120_000;
const TICK = 15_000;
/** 离发版不到这么久时横幅加强提示 */
const SOON = 5 * 60_000;

export type AnnouncementPhase = "notice" | "scheduled" | "live" | "done";

export function announcementPhase(a: Announcement, now: number): AnnouncementPhase {
  if (a.kind === "notice") return "notice";
  if (a.completed_at) return "done";
  return a.starts_at && now < a.starts_at ? "scheduled" : "live";
}

function remaining(ms: number, relative = false) {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return t("不到 1 分钟");
  if (minutes < 60) return t(relative ? "还有 {p0} 分钟" : "{p0} 分钟", { p0: minutes });
  return t(relative ? "还有 {p0} 小时 {p1} 分钟" : "{p0} 小时 {p1} 分钟", { p0: Math.floor(minutes / 60), p1: minutes % 60 });
}

/** 管理员页的完整预告，也用作非计划状态的横幅标题。 */
export function announcementTitle(a: Announcement, now: number): string {
  const downtime = a.duration_min || 0;
  switch (announcementPhase(a, now)) {
    case "notice":
      return t("管理员通知");
    case "done":
      return t("服务已升级到 {p0}，可以正常使用。", { p0: a.completed_version || "" });
    case "live":
      return downtime
        ? t("正在发版升级，预计中断约 {p0} 分钟，页面和终端可能短暂断开。", { p0: downtime })
        : t("正在发版升级，页面和终端可能短暂断开。");
    case "scheduled": {
      const at = fmtTime(a.starts_at!, i18n.locale), left = remaining(a.starts_at! - now, true);
      return downtime
        ? t("计划于 {p0} 发版升级（{p1}），预计中断约 {p2} 分钟。请先保存进度，避免在此期间开始长任务。", { p0: at, p1: left, p2: downtime })
        : t("计划于 {p0} 发版升级（{p1}）。请先保存进度，避免在此期间开始长任务。", { p0: at, p1: left });
    }
  }
}

let current: Announcement | null = null;
let rendered: Announcement | null = null;
let skew = 0; // 服务端时钟 - 本机时钟
let lastFetch = 0;
let seq = 0;

const serverNow = () => Date.now() + skew;

function dismissKey(a: Announcement) {
  return a.id + (a.completed_at ? ":done" : "");
}

function dismissed(a: Announcement) {
  try { return localStorage.getItem(DISMISSED) === dismissKey(a); } catch { return false; }
}

function render() {
  const bar = $("announce-bar");
  const a = current;
  if (!a || dismissed(a)) { bar.hidden = true; return; }
  const now = serverNow();
  const phase = announcementPhase(a, now);
  const scheduled = phase === "scheduled";
  const startsAt = a.starts_at ?? 0;
  const changed = rendered !== a || bar.dataset.phase !== phase;
  bar.classList.toggle("soon", scheduled && startsAt - now <= SOON);
  const date = $<HTMLTimeElement>("announce-date");
  // Countdown ticks should not announce the same title and message again.
  if (changed) {
    rendered = a;
    bar.dataset.phase = phase;
    setTextRender($("announce-title"), () => scheduled ? t("已计划发版升级") : announcementTitle(a, now));
    const details = $("announce-details");
    date.hidden = details.hidden = $("announce-countdown").hidden = !scheduled;
    if (scheduled) {
      date.dateTime = new Date(startsAt).toISOString();
      setTextRender(details, () => a.duration_min
        ? t("预计中断约 {p0} 分钟。请先保存进度，避免在此期间开始长任务。", { p0: a.duration_min })
        : t("请先保存进度，避免在此期间开始长任务。"));
    }
    const msg = $("announce-msg");
    msg.textContent = phase === "done" ? "" : a.message;
    msg.hidden = !msg.textContent;
  }
  if (scheduled) {
    const dateLabel = () => fmtTime(startsAt, i18n.locale);
    if (changed || date.textContent !== dateLabel()) setTextRender(date, dateLabel);
    const countdown = $("announce-remaining");
    const countdownLabel = () => remaining(startsAt - serverNow());
    if (changed || countdown.textContent !== countdownLabel()) setTextRender(countdown, countdownLabel);
  }
  bar.hidden = false;
}

async function refresh() {
  const mine = ++seq;
  lastFetch = Date.now();
  try {
    const v = await api<AnnouncementView>("/announcement");
    if (mine !== seq) return;
    skew = v.now ? v.now - Date.now() : 0;
    current = v.announcement;
  } catch {
    return; // 读不到就保持原样；离线横幅会说明连接问题
  }
  render();
}

/** 登录期间的生命周期。 */
export function initAnnouncement() {
  const bar = $("announce-bar");
  const close = $("announce-close");
  const onClose = () => {
    if (current) try { localStorage.setItem(DISMISSED, dismissKey(current)); } catch { /* 存不了就只收起这一次 */ }
    bar.hidden = true;
  };
  const onChanged = () => void refresh();
  const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
  close.addEventListener("click", onClose);
  bus.addEventListener("announcement-changed", onChanged);
  document.addEventListener("visibilitychange", onVisible);
  const tick = setInterval(() => {
    if (!usageLiveConnected() && Date.now() - lastFetch >= FALLBACK_POLL) void refresh();
    else render();
  }, TICK);
  watchUsageLive("announcement", true);
  void refresh();
  return () => {
    seq++;
    clearInterval(tick);
    close.removeEventListener("click", onClose);
    bus.removeEventListener("announcement-changed", onChanged);
    document.removeEventListener("visibilitychange", onVisible);
    watchUsageLive("announcement", false);
    current = null;
    rendered = null;
    bar.hidden = true;
  };
}
