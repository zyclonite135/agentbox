/* Claude Code 的 tool_progress：长命令定期报一次还在跑。
 * 连续的心跳合成一行，点开看各次的工具、已运行时长和原始事件。 */
import type { AgentEvent } from "../../types.js";
import { svgIcon, type IconSlot } from "../../icons.js";
import { setText, setTextRender, t as i18nText } from "../../i18n.js";
import { el } from "./tool-rows.js";

const labels = new WeakMap<Element, (n: number) => string>();

function newFold(icon: IconSlot, text: (n: number) => string) {
  const wrap = el("div", "fold fold-beat");
  const head = el("div", "fold-head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", "false");
  const label = el("span", "fold-text");
  const items = el("div", "fold-items");
  head.append(svgIcon(icon, 13), label);
  wrap.append(head, items);
  labels.set(wrap, text);
  const toggle = () => {
    const open = !wrap.classList.contains("fold-open");
    wrap.classList.toggle("fold-open", open);
    head.setAttribute("aria-expanded", String(open));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  return wrap;
}

/* 条数变了重新绑定标题（重新绑定会立即重画，语言切换时也按它重算） */
function recount(fold: Element) {
  const label = fold.querySelector<HTMLElement>(":scope > .fold-head > .fold-text"), text = labels.get(fold);
  const n = fold.querySelector(":scope > .fold-items")!.childElementCount;
  if (label && text) setTextRender(label, () => text(n));
}

function secs(s: number) {
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

/** tool_progress → 只有一条的心跳组；紧跟在另一个心跳组后面时由 foldInto 并进去 */
export function heartbeatNode(ev: AgentEvent, title: string) {
  const fold = newFold("heart-pulse", n => i18nText("心跳检查 · {p0} 次", { p0: String(n) }));
  const item = document.createElement("details");
  item.className = "fold-item beat";
  const sum = document.createElement("summary");
  const elapsed = typeof ev.elapsed_time_seconds === "number" ? ev.elapsed_time_seconds : undefined;
  const what = el("span", "beat-what", title);
  const time = el("span", "beat-time");
  if (elapsed !== undefined) setText(time, "已运行 {p0}", { p0: secs(elapsed) });
  sum.append(what, time);
  const pre = el("pre", "beat-raw mono", JSON.stringify(ev, null, 2));
  item.append(sum, pre);
  item.dataset.elapsed = elapsed !== undefined ? String(elapsed) : "";
  fold.querySelector(".fold-items")!.append(item);
  relabel(fold);
  return fold;
}

/* 心跳组标题后跟最近一次的已运行时长 */
function relabel(fold: Element) {
  recount(fold);
  const head = fold.querySelector(":scope > .fold-head")!;
  const last = fold.querySelector<HTMLElement>(":scope > .fold-items > .fold-item:last-child");
  const elapsed = Number(last?.dataset.elapsed || NaN);
  let meta = head.querySelector<HTMLElement>(".fold-meta");
  if (!Number.isFinite(elapsed)) { meta?.remove(); return; }
  if (!meta) { meta = el("span", "fold-meta"); head.append(meta); }
  const what = last?.querySelector(".beat-what")?.textContent || "";
  setTextRender(meta, () => " · " + (what ? what + " " : "") + i18nText("已运行 {p0}", { p0: secs(elapsed) }));
}

/* ---------------- 入口 ---------------- */

/** 新节点能并进紧挨着的前一个节点就并进去，返回 true（调用方不再插入它） */
export function foldInto(prev: Element | null, node: HTMLElement) {
  if (!prev?.classList.contains("fold-beat") || !node.classList.contains("fold-beat")) return false;
  prev.querySelector(".fold-items")!.append(...node.querySelector(".fold-items")!.children);
  relabel(prev);
  return true;
}
