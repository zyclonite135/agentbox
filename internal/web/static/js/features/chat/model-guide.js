import { setAttrRender, setText, setTextRender, t } from "../../i18n.js";
import { svgIcon } from "../../icons.js";
import { agentIcon } from "../../brand.js";
import { sessionState } from "../../session-state.js";
import { bus } from "../../state.js";
import { $, keepScroll } from "../../util.js";
// Use explicit model IDs. A proxy alias may point to a different model.
// References: OpenAI's model-selection guide and Anthropic's model announcements.
const guidance = new Map([
    ...["gpt-6.2-astra", "gpt-6-astra"].map(id => [id,
        "适合复杂的多步骤任务，例如对照多份报告、找出数字差异，或分析程序故障的原因。"]),
    ...["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"].map(id => [id,
        "适合日常工作，例如起草邮件、根据多份文档汇总报告，或修改代码。"]),
    ["gpt-6.1-terra", "适合处理图像和文字，例如解释图表或截图中的内容，并把观察结果整理成清晰的报告。"],
    ["gpt-5.6-terra", "适合成果明确的小任务，例如整理会议记录、修改报告中的一段文字，或调整一小段代码。"],
    ...["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"].map(id => [id,
        "适合简短或重复的任务，例如精简文字、为申请分类，或从清单中摘出日期和金额。"]),
    ...["gpt-5.5", "gpt-5.4", "gpt-5.2"].map(id => [id,
        "适合处理公式和代码，例如排查表格合计错误、编写脚本处理数据行，或检查函数的运行方式。"]),
    ...["claude-fable-5-2", "claude-fable-5-1", "claude-fable-5"].map(id => [id,
        "适合需要研究材料并提出方案的任务，例如比较演示文稿的设计方案、从多个来源汇集想法，或弄清陌生项目的结构。"]),
    ...["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101"].map(id => [id,
        "适合细致审查和耗时较长的任务，例如核对多份文档、标出矛盾并说明哪些地方需要关注。也适合修改程序中相互关联的多个部分。"]),
    ...["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"].map(id => [id,
        "适合目标明确的日常工作，例如整理操作说明、根据表格生成摘要，或修复已找到的代码错误。"]),
    ...["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"].map(id => [id,
        "适合批量处理同类记录，例如按主题整理咨询、从邮件中提取关键信息，或填写表格中的相同字段。"]),
]);
const dialog = () => $("dlg-model-guide");
let activeTrigger;
export function closeModelGuide(trigger) {
    const modal = dialog();
    if (modal.open && (!trigger || activeTrigger === trigger)) {
        activeTrigger = undefined;
        modal.close();
    }
}
export function openModelGuide(trigger, context) {
    const modal = dialog();
    if (modal.open)
        return;
    activeTrigger = trigger;
    renderModelGuide(context);
    trigger.focus({ preventScroll: true });
    modal.showModal();
    modal.querySelector(".dlg-body")?.scrollTo(0, 0);
}
export function updateModelGuide(trigger, context) {
    if (dialog().open && activeTrigger === trigger)
        renderModelGuide(context);
}
function renderGuideHeading({ caption, workspace, agent = workspace?.agent }) {
    const name = $("model-guide-space");
    setTextRender(name, caption);
    setAttrRender(name, "title", () => agent ? caption() : "");
    const brand = $("model-guide-agent");
    brand.hidden = !agent;
    brand.replaceChildren(...(agent ? [agentIcon(agent, 24)] : []));
    const dot = $("model-guide-state");
    dot.hidden = !workspace;
    if (workspace) {
        dot.className = "model-guide-state " + sessionState(workspace).cls;
        setAttrRender(dot, "aria-label", () => sessionState(workspace).label);
        setAttrRender(dot, "title", () => sessionState(workspace).label);
    }
}
function renderModelGuide(context) {
    renderGuideHeading(context);
    const { models, current, select } = context;
    const focusedModel = document.activeElement?.dataset.guideModel;
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
        else if (select) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-sm model-guide-select";
            button.dataset.guideModel = id;
            setText(button, "选用模型");
            setAttrRender(button, "aria-label", () => t("选用模型 {model}", { model: label || id }));
            button.addEventListener("click", () => { if (select(id))
                closeModelGuide(); });
            header.append(button);
        }
        const description = document.createElement("p");
        setText(description, guidance.get(id) || "此模型暂无经过核实的用途说明。");
        row.append(header, description);
        return row;
    });
    const list = $("model-guide-list");
    keepScroll(list, () => list.replaceChildren(...rows));
    $("model-guide-empty").hidden = rows.length > 0;
    if (focusedModel) {
        const button = [...list.querySelectorAll("button")].find(el => el.dataset.guideModel === focusedModel);
        (button || $("btn-model-guide-close")).focus({ preventScroll: true });
    }
}
let introduced = false;
export function initModelGuide(read, signal) {
    const trigger = $("btn-model-guide");
    const modal = dialog();
    bus.addEventListener("data-updated", () => {
        if (!modal.open || activeTrigger !== trigger)
            return;
        const context = read();
        if (context)
            renderGuideHeading(context);
    }, { signal });
    matchMedia("(max-width: 760px)").addEventListener("change", event => {
        if (event.matches)
            closeModelGuide(trigger);
    }, { signal });
    if (!introduced) {
        const observer = new IntersectionObserver(entries => {
            if (signal.aborted || !entries.some(entry => entry.isIntersecting))
                return;
            observer.disconnect();
            introduced = true;
            if (matchMedia("(prefers-reduced-motion: no-preference)").matches)
                trigger.classList.add("guide-intro");
        });
        observer.observe(trigger);
        signal.addEventListener("abort", () => {
            observer.disconnect();
            trigger.classList.remove("guide-intro");
        }, { once: true });
    }
    const clearIntro = (event) => {
        if (event.animationName === "model-guide-shine")
            trigger.classList.remove("guide-intro");
    };
    trigger.addEventListener("animationend", clearIntro, { signal });
    trigger.addEventListener("animationcancel", clearIntro, { signal });
    trigger.addEventListener("click", () => {
        const context = read();
        if (context)
            openModelGuide(trigger, context);
    }, { signal });
    $("btn-model-guide-close").addEventListener("click", () => closeModelGuide(), { signal });
    modal.addEventListener("close", () => { if (!modal.open)
        activeTrigger = undefined; }, { signal });
    const isBackdrop = (event) => {
        if (event.target !== modal)
            return false;
        const bounds = modal.getBoundingClientRect();
        return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    let pressedBackdrop = false;
    modal.addEventListener("pointerdown", event => {
        pressedBackdrop = event.isPrimary && event.button === 0 && isBackdrop(event);
    }, { signal });
    modal.addEventListener("pointercancel", () => { pressedBackdrop = false; }, { signal });
    modal.addEventListener("click", event => {
        if (pressedBackdrop && isBackdrop(event))
            closeModelGuide();
        pressedBackdrop = false;
    }, { signal });
}
