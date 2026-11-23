import { setAttrRender, setText, setTextRender, t as i18nText } from "./i18n.js";
/* Per-turn context uses persisted request settings, never the current picker. */
import type { AgentEvent, ChatTurnMetadata, ChatTurnCost } from "./types.js";
import { answerSources, copyText } from "./chat-render.js";
import { svgIcon } from "./icons.js";
import { EFFORT_LABELS } from "./reasoning.js";
import { S } from "./state.js";
import { setTip } from "./tip.js";
import { toast, fmtDateTime, fmtElapsed } from "./util.js";

export interface AnswerContext {
  turn?: ChatTurnMetadata;
  ts?: string;
  reportedModel?: string;
  cost?: ChatTurnCost;
  /** cost 是回合进行中已结算请求的累计，不是最终金额 */
  costRunning?: boolean;
  legacyCost?: number;
  historical?: boolean;
  /** 斜杠命令的回合（CLI 报 num_turns=0）：/context 不请求模型，/compact 会 */
  local?: boolean;
  /** 回合总耗时（服务端在最终 status 里记的墙钟时间） */
  duration?: number;
}


/** Old Claude logs can supply a model; missing effort remains unknown. */
export function observeAnswer(context: AnswerContext, ev?: AgentEvent, ts?: string) {
  if (!ev || ev.parent_tool_use_id) return;
  // Old transcripts have no turn ID to join with the ledger. Preserve the
  // CLI's reported amount, explicitly labelled, without pricing old tokens now.
  if (ev.type === "result" && !context.turn) {
    const models = ev.modelUsage as Record<string, { costUSD?: number }> | undefined;
    const costs = models && typeof models === "object" ? Object.values(models).map(m => m?.costUSD) : [];
    const value = costs.length && costs.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      ? costs.reduce<number>((sum, n) => sum + Math.round(n! * 1e6), 0)
      : typeof ev.total_cost_usd === "number" && Number.isFinite(ev.total_cost_usd) ? Math.round(ev.total_cost_usd * 1e6) : 0;
    context.legacyCost = value > 0 ? value : undefined;
  }
  if (ev.type === "result") context.local = ev.num_turns === 0 && ev.is_error === false;
  if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta" && ts) context.ts = ts;
  const model = ev.type === "assistant" ? ev.message?.model
    : ev.type === "system" && ev.subtype === "init" ? ev.model : undefined;
  if (typeof model === "string" && model && !model.startsWith("<")) context.reportedModel = model;
  const text = ev.type === "assistant" && Array.isArray(ev.message?.content)
    ? ev.message.content.some(block => block.type === "text" && block.text)
    : ev.type === "item.completed" && ev.item?.type === "agent_message"
      || ev.msg?.type === "agent_message" || ev.type === "agent_message";
  if (text && ts) context.ts = ts;
}

function reasoningText(turn?: ChatTurnMetadata): string {
  if (!turn) return i18nText("未记录");
  if (turn.unsupported) return i18nText("不支持调整");
  if (!turn.effort) return i18nText("默认");
  if (turn.control === "budget") {
    return turn.budget_tokens ? i18nText("思考预算 {p0} tokens", { p0: String(turn.budget_tokens.toLocaleString("en-US")) })
      : i18nText("思考预算 · {p0}", { p0: String(EFFORT_LABELS[turn.effort] || turn.effort) });
  }
  return EFFORT_LABELS[turn.effort] || turn.effort;
}

/* 计费来源写成用户看得懂的话：「价目表」「CLI 报告」是实现细节 */
const SOURCE_TEXT: Record<string, string> = { get table() { return i18nText("按单价估算"); }, get provider() { return i18nText("客户端上报"); }, get mixed() { return i18nText("部分按单价估算"); } };

function costView(context: AnswerContext): { label: string; detail: string; priced: boolean } {
  const money = (micro: number) => "$" + (micro / 1e6).toFixed(micro > 0 && micro < 100 ? 6 : 4);
  const cost = context.cost;
  if (cost && cost.source !== "unknown") {
    if (cost.source === "unpriced") return { label: i18nText("未定价"), detail: i18nText("模型未设置单价。"), priced: false };
    const source = SOURCE_TEXT[cost.source] || i18nText("混合计价");
    const partial = cost.partial ? i18nText("部分模型未设置单价，金额不完整") : "";
    if (context.costRunning) return {
      label: i18nText("{p0} · 累计中", { p0: (cost.partial ? "≥ " : "") + money(cost.cost_micro_usd) }),
      detail: partial || i18nText("回合结束后显示最终金额。"),
      priced: true,
    };
    return {
      label: (cost.partial ? "≥ " : "") + money(cost.cost_micro_usd),
      detail: partial || source,
      priced: true,
    };
  }
  // /compact 同样 num_turns=0 却会请求模型：等服务端确认这一轮没有用量再这么说
  if (context.local && (cost ? cost.source === "unknown" : context.historical)) return {
    label: i18nText("未调用模型"),
    detail: i18nText("命令在本地执行。"), priced: false,
  };
  if (!context.turn && context.legacyCost !== undefined) return {
    label: money(context.legacyCost),
    detail: i18nText("客户端上报"), priced: true,
  };
  const pending = !cost && !context.historical;
  return { label: pending ? i18nText("费用待结算") : i18nText("费用未记录"), detail: pending ? i18nText("回合结束后显示最终金额。") : i18nText("没有费用记录。"), priced: false };
}

export function answerFooter(body: HTMLElement, context: AnswerContext) {
  const el = document.createElement("div");
  el.className = "answer-footer";
  el.setAttribute("role", "group");
  setAttrRender(el, "aria-label", () => i18nText("回答信息与操作"));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "answer-copy";
  setAttrRender(copy, "aria-label", () => i18nText("复制回答"));
  copy.append(svgIcon("copy", 16));
  setTip(copy, () => i18nText("复制回答（Markdown）"));
  const actions = document.createElement("div");
  actions.className = "answer-actions";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "answer-copy answer-more";
  setAttrRender(more, "aria-label", () => i18nText("回答详情"));
  more.setAttribute("aria-expanded", "false");
  more.append(svgIcon("info", 16));
  setTip(more, () => i18nText("回答详情"));
  // 外面只放时间和金额；模型、推理强度、计费说明与本轮 token 收进「详情」
  const details = document.createElement("div");
  details.className = "answer-details";
  const detailsShell = document.createElement("div");
  detailsShell.className = "answer-details-shell";
  detailsShell.inert = true;
  const detailsClip = document.createElement("div");
  detailsClip.className = "answer-details-clip";
  detailsClip.append(details);
  detailsShell.append(detailsClip);
  const detailRow = (key: () => string) => {
    const row = document.createElement("div");
    row.className = "ad-row";
    const k = Object.assign(document.createElement("span"), { className: "ad-k" });
    setTextRender(k, key);
    const v = Object.assign(document.createElement("span"), { className: "ad-v" });
    const note = Object.assign(document.createElement("span"), { className: "ad-note" });
    row.append(k, v, note);
    return { row, v, note };
  };
  const model = detailRow(() => i18nText("模型"));
  const effort = detailRow(() => i18nText("推理强度"));
  const costDetail = detailRow(() => i18nText("费用"));
  const calculation = document.createElement("details");
  calculation.className = "answer-calculation";
  const calculationLabel = document.createElement("summary");
  setText(calculationLabel, "费用如何计算");
  calculation.append(calculationLabel, costDetail.note);
  costDetail.row.append(calculation);
  const durationDetail = detailRow(() => i18nText("耗时"));
  durationDetail.row.classList.add("answer-duration-detail");
  const receipt = document.createElement("div");
  receipt.className = "answer-receipt";
  details.append(model.row, effort.row, durationDetail.row, costDetail.row, receipt);
  more.addEventListener("click", () => {
    const open = detailsShell.classList.toggle("open");
    detailsShell.inert = !open;
    more.setAttribute("aria-expanded", String(open));
  });
  actions.append(copy, more);
  const info = document.createElement("div");
  info.className = "answer-context";
  const date = document.createElement("time");
  date.className = "answer-time";
  const took = document.createElement("span");
  took.className = "answer-duration";
  const cost = document.createElement("span");
  cost.className = "answer-cost";
  info.append(date, took, cost);
  el.append(actions, info, detailsShell);
  copy.addEventListener("click", async () => {
    const source = [...body.querySelectorAll<HTMLElement>(".msg.agent")]
      .map(node => answerSources.get(node) || "").filter(Boolean).join("\n\n");
    if (!source) return;
    try { await copyText(source); }
    catch (_) { toast(i18nText("复制失败，请选择回答后手动复制"), true); return; }
    copy.replaceChildren(svgIcon("check", 16));
    copy.classList.add("copied");
    setAttrRender(copy, "aria-label", () => i18nText("已复制回答"));
    setTip(copy, () => i18nText("已复制"));
    copy.disabled = true;
    setTimeout(() => {
      copy.replaceChildren(svgIcon("copy", 16));
      copy.classList.remove("copied");
      setAttrRender(copy, "aria-label", () => i18nText("复制回答"));
      setTip(copy, () => i18nText("复制回答（Markdown）"));
      copy.disabled = false;
    }, 1400);
  });
  function update() {
    el.hidden = ![...body.querySelectorAll<HTMLElement>(".msg.agent")].some(node => answerSources.has(node));
    const turn = context.turn;
    setTextRender(model.v, () => context.reportedModel || turn?.model || i18nText("未记录"));
    setTextRender(model.note, () => context.reportedModel
      ? (turn && turn.model !== context.reportedModel ? i18nText("请求的是 {p0}，以模型实际返回为准", { p0: String(turn.model) }) : "")
      : turn ? i18nText("请求的模型") : "");
    setTextRender(effort.v, () => reasoningText(turn));
    setTextRender(effort.note, () => !turn ? i18nText("这条历史回答未记录推理设置")
      : turn.unsupported ? i18nText("本轮模型不支持调整推理强度")
      : !turn.effort ? i18nText("本轮未指定，沿用模型默认")
      : turn.control === "budget" ? i18nText("这是请求的思考预算上限，并非实际消耗")
      : "");
    const d = context.ts ? new Date(context.ts) : null;
    if (d && Number.isFinite(d.getTime())) {
      const zone = S.timeZone || "Asia/Shanghai";
      date.textContent = fmtDateTime(d, false);
      date.dateTime = d.toISOString();
      setTip(date, () => i18nText("回答时间：{p0}（{p1}）", { p0: String(fmtDateTime(d)), p1: String(zone) }));
    } else {
      setText(date, "时间未记录");
      date.removeAttribute("datetime");
      setTip(date, () => i18nText("这条回答未记录时间"));
    }
    took.hidden = !context.duration;
    durationDetail.row.hidden = took.hidden;
    if (context.duration) {
      const ms = context.duration;
      setTextRender(took, () => i18nText("用时 {d}", { d: fmtElapsed(ms) }));
      setTextRender(durationDetail.v, () => fmtElapsed(ms));
      setTip(took, () => i18nText("本轮从开始到结束共用时 {d}", { d: fmtElapsed(ms) }));
    }
    const price = costView(context);
    setTextRender(cost, () => costView(context).label);
    cost.classList.toggle("priced", price.priced);
    setTip(cost, () => costView(context).detail);
    setTextRender(costDetail.v, () => costView(context).label);
    setTextRender(costDetail.note, () => costView(context).detail);
  }
  return { el, update, setReceipt: (node: HTMLElement) => receipt.replaceChildren(node) };
}
