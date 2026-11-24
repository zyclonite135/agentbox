import { svgIcon } from "../../icons.js";
import { setTextRender, t } from "../../i18n.js";

const captions = {
  read: ["读文件 {p0} 次", "正在读取文件…"],
  list: ["列目录 {p0} 次", "正在列出目录…"],
  search: ["搜索次数 {p0}", "正在搜索…"],
  command: ["命令 {p0} 条", "执行命令…"],
  edit: ["文件变更 {p0} 项", "正在修改文件…"],
  tool: ["工具调用 {p0} 次", "正在运行工具…"],
  reasoning: ["推理摘要 {p0} 段", "推理中…"],
} as const;
type ActivityKind = keyof typeof captions;
const steps = new WeakMap<Element, { kind: ActivityKind; key: string; legacyCommand: string }>();
const groups = new WeakMap<Element, { fold: HTMLDetailsElement; items: HTMLElement }>();

export function markActivity(node: HTMLElement, kind: ActivityKind, key = "", legacyCommand = "") {
  steps.set(node, { kind, key, legacyCommand });
  return node;
}

function title(items: HTMLElement) {
  const counts = new Map<ActivityKind, number>();
  let running: ActivityKind | undefined;
  for (const node of items.children) {
    const step = steps.get(node);
    if (!step) continue;
    counts.set(step.kind, (counts.get(step.kind) || 0) + 1);
    if ((node as HTMLElement).dataset.status === "running") running = step.kind;
  }
  if (running) return t(captions[running][1]);
  const parts = [...counts].map(([kind, count]) => t(captions[kind][0], { p0: String(count) }));
  return t("工作过程") + " · " + parts.join(", ");
}

/** Store the existing tool nodes inside a native disclosure, including their handlers and results. */
export function activityNode(prev: Element | null, node: HTMLElement): HTMLElement | null {
  if (!steps.has(node)) return node;
  const previous = prev && groups.get(prev);
  if (previous) { previous.items.append(node); return null; }

  const fold = document.createElement("details");
  fold.className = "fold fold-activity";
  const head = document.createElement("summary");
  head.className = "fold-head";
  const label = document.createElement("span");
  label.className = "fold-text";
  const items = document.createElement("div");
  items.className = "fold-items";
  head.append(svgIcon("chat.tool-group", 13), label);
  items.append(node);
  fold.append(head, items);
  groups.set(fold, { fold, items });
  const renderTitle = () => title(items);
  setTextRender(label, renderTitle);

  // The live renderer replaces temporary reasoning nodes and updates tool rows in place.
  // Batch those changes so a replacement keeps its existing disclosure and open state.
  new MutationObserver(records => {
    if (!records.some(record => record.target === items ||
      record.type === "attributes" && record.target.parentNode === items)) return;
    if (!items.childElementCount) fold.remove();
    else setTextRender(label, renderTitle);
  }).observe(items, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-status"] });
  return fold;
}

const settled = (node: Element) => !node.matches('[data-status="running"],[data-status="unfinished"]');

/** Rejoin an activity split across history pages, keeping completed tools at their original positions. */
export function joinActivity(older: Element[], newer: HTMLElement) {
  const pending = new Map<string, Element>();
  for (const node of older) {
    const group = groups.get(node);
    if (!group) continue;
    for (const step of group.items.children) {
      const key = steps.get(step)?.key;
      if (key && step.matches('[data-status="unfinished"]')) pending.set(key, step);
    }
  }
  for (const node of [...newer.children]) {
    const group = groups.get(node);
    if (!group) continue;
    for (const step of [...group.items.children]) {
      const key = steps.get(step)?.key;
      const start = key && pending.get(key);
      if (!start || !settled(step)) continue;
      const earlier = start.parentElement?.parentElement;
      if (earlier instanceof HTMLDetailsElement) earlier.open ||= group.fold.open;
      start.replaceWith(step);
      pending.delete(key);
    }
    if (!group.items.childElementCount) node.remove();
  }

  const last = older.at(-1), first = newer.firstElementChild;
  const from = last && groups.get(last), to = first && groups.get(first);
  if (from && to) {
    // Old Codex logs put an ID-less command's start and completion next to each other.
    const start = from.items.lastElementChild, end = to.items.firstElementChild;
    const command = start && steps.get(start)?.legacyCommand;
    if (start && end && command && start.matches('[data-status="unfinished"]') &&
      command === steps.get(end)?.legacyCommand && settled(end)) start.replaceWith(end);
    to.items.prepend(...from.items.children);
    to.fold.open ||= from.fold.open;
    from.fold.remove();
  }
}
