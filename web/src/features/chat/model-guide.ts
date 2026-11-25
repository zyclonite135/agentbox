import { setText, setTextRender } from "../../i18n.js";
import { svgIcon } from "../../icons.js";
import { $, keepScroll } from "../../util.js";
import type { ModelOption } from "../../types.js";

// Use explicit model IDs. A proxy alias may point to a different model.
// References: OpenAI's model-selection guide and Anthropic's model announcements.
const guidance = new Map<string, string>([
  ...["gpt-6.2-astra", "gpt-6-astra"].map(id => [id,
    "适合复杂的工程与分析任务，例如排查棘手的故障、评估架构方案。"] as const),
  ...["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"].map(id => [id,
    "适合日常工程工作，例如实现功能、综合多份研究资料。"] as const),
  ["gpt-6.1-terra", "适合视觉分析和写作，例如解读界面截图、润色报告。"],
  ["gpt-5.6-terra", "适合常规任务，例如起草报告、修改一段代码。"],
  ...["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"].map(id => [id,
    "适合简短或重复的任务，例如提取字段、分类条目。"] as const),
  ...["gpt-5.5", "gpt-5.4", "gpt-5.2"].map(id => [id,
    "适合编程与分析，例如定位代码问题、为现有功能补充测试。"] as const),
  ...["claude-fable-5-2", "claude-fable-5-1", "claude-fable-5"].map(id => [id,
    "适合开放式的工程与研究任务，例如梳理复杂代码库、比较设计方案。"] as const),
  ...["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101"].map(id => [id,
    "适合需要审慎判断的长任务，例如跨模块重构、逐步审查代码。"] as const),
  ...["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"].map(id => [id,
    "适合目标明确的日常工作，例如修复已定位的问题、整理文档或表格。"] as const),
  ...["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"].map(id => [id,
    "适合批量处理简单任务，例如归类记录、提取关键信息。"] as const),
]);

interface GuideContext {
  workspace: string;
  models: ModelOption[];
  current: string;
}

const dialog = () => $<HTMLDialogElement>("dlg-model-guide");

export function closeModelGuide() {
  if (dialog().open) dialog().close();
}

export function renderModelGuide({ workspace, models, current }: GuideContext) {
  setTextRender($("model-guide-space"), () => workspace);
  const rows = models.map(({ id, label }) => {
    const row = document.createElement("li");
    row.className = "model-guide-model";
    const header = document.createElement("header");
    const name = document.createElement("h3");
    name.textContent = label || id;
    header.append(name);
    if (id === current) {
      row.classList.add("is-current");
      const badge = document.createElement("span");
      badge.className = "model-guide-current";
      const text = document.createElement("span");
      setText(text, "当前选择");
      badge.append(svgIcon("check", 14), text);
      header.append(badge);
    }
    const description = document.createElement("p");
    setText(description, guidance.get(id) || "此模型暂无经过核实的用途说明。");
    row.append(header, description);
    return row;
  });
  const list = $("model-guide-list");
  keepScroll(list, () => list.replaceChildren(...rows));
  $("model-guide-empty").hidden = rows.length > 0;
}

let introduced = false;

export function initModelGuide(read: () => GuideContext | undefined, signal: AbortSignal) {
  const trigger = $("btn-model-guide");
  const modal = dialog();
  matchMedia("(max-width: 760px)").addEventListener("change", event => {
    if (event.matches) closeModelGuide();
  }, { signal });
  if (!introduced) {
    const observer = new IntersectionObserver(entries => {
      if (signal.aborted || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      introduced = true;
      if (matchMedia("(prefers-reduced-motion: no-preference)").matches) trigger.classList.add("guide-intro");
    });
    observer.observe(trigger);
    signal.addEventListener("abort", () => {
      observer.disconnect();
      trigger.classList.remove("guide-intro");
    }, { once: true });
  }
  const clearIntro = (event: AnimationEvent) => {
    if (event.animationName === "model-guide-shine") trigger.classList.remove("guide-intro");
  };
  trigger.addEventListener("animationend", clearIntro, { signal });
  trigger.addEventListener("animationcancel", clearIntro, { signal });
  trigger.addEventListener("click", () => {
    const context = read();
    if (!context || modal.open) return;
    renderModelGuide(context);
    trigger.focus({ preventScroll: true });
    modal.showModal();
    modal.querySelector(".dlg-body")?.scrollTo(0, 0);
  }, { signal });
  $("btn-model-guide-close").addEventListener("click", closeModelGuide, { signal });
  const isBackdrop = (event: MouseEvent) => {
    if (event.target !== modal) return false;
    const bounds = modal.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  let pressedBackdrop = false;
  modal.addEventListener("pointerdown", event => {
    pressedBackdrop = event.isPrimary && event.button === 0 && isBackdrop(event);
  }, { signal });
  modal.addEventListener("pointercancel", () => { pressedBackdrop = false; }, { signal });
  modal.addEventListener("click", event => {
    if (pressedBackdrop && isBackdrop(event)) closeModelGuide();
    pressedBackdrop = false;
  }, { signal });
}
