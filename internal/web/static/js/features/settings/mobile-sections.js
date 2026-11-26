import { setTextRender, t } from "../../i18n.js";
import { mountSettingsFold, settingsHelpText } from "./mobile-layout.js";
function wrap(element, className, signal) {
    const wrapper = document.createElement("div");
    wrapper.className = className;
    element.before(wrapper);
    wrapper.append(element);
    signal.addEventListener("abort", () => wrapper.replaceWith(element), { once: true });
    return wrapper;
}
function mark(element, className, signal) {
    element.classList.add(className);
    signal.addEventListener("abort", () => element.classList.remove(className), { once: true });
}
function mountGroups(section, signal) {
    const peers = [];
    const topical = [...section.querySelectorAll(":scope > [data-settings-topic]")];
    const decision = [...section.querySelectorAll("#decision-settings-fields > .card")];
    const preferences = [...section.querySelectorAll(":scope > .interface-preferences > .interface-group, :scope > .interface-group")];
    const decisionIcons = ["sparkles", "key", "sliders"];
    const preferenceIcons = ["database", "sparkles", "message", "settings"];
    const topics = [...topical, ...decision, ...preferences];
    const helpRows = new Map();
    for (const [index, topic] of topics.entries()) {
        const body = topic.querySelector(":scope > .settings-block, :scope > .interface-card") ?? topic;
        const wrapper = body === topic ? wrap(topic, "settings-mobile-wrap", signal) : topic;
        const headings = [...topic.querySelectorAll("h3,.interface-group-title")];
        // The update panel's first heading is the AgentBox wordmark, not the subsection name.
        const heading = topic.id === "settings-update-panel"
            ? headings.find(node => node.dataset.i18n === topic.dataset.settingsTopic)
            : headings[0];
        if (!topic.dataset.settingsTopic && !heading)
            continue;
        const title = () => topic.dataset.settingsTopic ? t(topic.dataset.settingsTopic) : heading.textContent.trim();
        const icon = topic.dataset.settingsTopicIcon
            ?? decisionIcons[decision.indexOf(topic)] ?? preferenceIcons[preferences.indexOf(topic)];
        const fold = mountSettingsFold(wrapper, body, topic, title, signal, { icon, heading: true, open: index === 0, peers });
        mark(wrapper, "settings-mobile-group", signal);
        if (heading)
            mark(heading, "settings-mobile-heading-source", signal);
        helpRows.set(topic, fold.row);
    }
    return helpRows;
}
function mountSectionHelp(section, addHelp, signal) {
    const lead = section.querySelector(":scope > .sec-intro > div:first-child, .interface-preferences > .sec-intro > div:first-child");
    if (!lead)
        return;
    const heading = lead.querySelector("h2");
    const description = lead.querySelector(":scope > p");
    if (!heading || !description?.textContent?.trim())
        return;
    const details = [...lead.querySelectorAll(":scope > details.settings-details")]
        .filter(node => !node.querySelector("a[href],button,input,select,textarea"));
    const overview = document.createElement("div");
    overview.className = "settings-mobile-overview settings-mobile-only";
    const text = document.createElement("span");
    setTextRender(text, () => description.textContent.trim());
    overview.append(text);
    lead.append(overview);
    const sources = [description, ...details];
    for (const source of sources)
        mark(source, "settings-help-source", signal);
    addHelp(overview, () => heading.textContent.trim(), () => sources.flatMap(settingsHelpText));
    signal.addEventListener("abort", () => overview.remove(), { once: true });
}
function mountCardHelp(section, helpRows, addHelp, signal) {
    const byOwner = new Map();
    for (const details of section.querySelectorAll("details.learn-more:not(.settings-help-source)")) {
        if (details.closest(".sec-intro") || !details.querySelector("p,li") ||
            details.querySelector("a[href],button,input,select,textarea,[contenteditable]"))
            continue;
        const owner = details.parentElement;
        const sources = byOwner.get(owner) ?? [];
        sources.push(details);
        byOwner.set(owner, sources);
    }
    if (section.classList.contains("settings-form")) {
        for (const description of section.querySelectorAll(".card > p.card-desc:not([id],[role])")) {
            if (!description.querySelector("a[href],button,input,select,textarea") && !byOwner.has(description.parentElement)) {
                byOwner.set(description.parentElement, []);
            }
        }
    }
    for (const [owner, details] of byOwner) {
        const description = owner.querySelector(":scope > p.card-desc:not([id],[role])");
        const sources = description ? [description, ...details] : details;
        const field = owner.querySelector(":scope > .interface-toggle, :scope > .interface-select-row");
        const heading = owner.querySelector(":scope > h3, :scope > h4, :scope > .card-head h3, :scope > .dc-head h3");
        const foldRow = helpRows.get(owner);
        let host;
        if (field)
            host = wrap(field, "settings-help-line", signal);
        else if (foldRow)
            host = foldRow;
        else if (heading) {
            host = heading;
            mark(heading, "settings-help-heading", signal);
        }
        else
            continue;
        const label = () => (heading ?? field?.querySelector("strong"))?.textContent?.trim() || t("了解更多");
        for (const source of sources)
            mark(source, "settings-help-source", signal);
        addHelp(host, label, () => sources.flatMap(settingsHelpText));
    }
}
function mountFieldHelp(section, addHelp, signal) {
    for (const field of section.querySelectorAll("label.field")) {
        const title = field.querySelector(":scope > span:first-child");
        const hints = [...field.querySelectorAll(":scope > .hint:not([role],.warn), :scope > .field-hint:not([role],.warn)")];
        if (!title || !hints.some(hint => hint.textContent?.trim()))
            continue;
        const host = wrap(field, "settings-help-field", signal);
        for (const hint of hints)
            mark(hint, "settings-help-source", signal);
        addHelp(host, () => title.textContent.trim(), () => hints.flatMap(settingsHelpText));
    }
    for (const legacy of section.querySelectorAll(".help:has(.help-tip)")) {
        const body = legacy.querySelector(".help-tip");
        const host = document.createElement("span");
        host.className = "settings-inline-help settings-mobile-only";
        legacy.after(host);
        mark(legacy, "settings-help-source", signal);
        addHelp(host, () => legacy.getAttribute("aria-label") || t("了解更多"), () => settingsHelpText(body));
        signal.addEventListener("abort", () => host.remove(), { once: true });
    }
}
export function initMobileSettingsSections(content, signal, addHelp) {
    for (const section of content.querySelectorAll(":scope > .set-section:not(#sec-security)")) {
        const rows = mountGroups(section, signal);
        mountSectionHelp(section, addHelp, signal);
        mountCardHelp(section, rows, addHelp, signal);
        mountFieldHelp(section, addHelp, signal);
    }
}
