import { setAttrRender, setTextRender, t } from "../../i18n.js";
import { svgIcon } from "../../icons.js";
import { bus } from "../../state.js";
const folds = new WeakMap();
let nextPanelId = 0;
export function mountSettingsFold(host, body, target, title, signal, options = {}) {
    const row = document.createElement("div");
    row.className = "settings-fold-row settings-mobile-only";
    if (options.heading) {
        row.setAttribute("role", "heading");
        row.setAttribute("aria-level", "3");
    }
    const initialId = body.id;
    if (!initialId)
        body.id = "settings-fold-panel-" + ++nextPanelId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-fold";
    button.setAttribute("aria-controls", body.id);
    const words = document.createElement("span");
    const label = document.createElement("span");
    setTextRender(label, title);
    const summary = document.createElement("small");
    summary.className = "settings-fold-summary";
    words.append(label, summary);
    if (options.icon)
        button.append(svgIcon(options.icon, 17));
    const caret = svgIcon("chevron", 14);
    caret.classList.add("settings-fold-caret");
    button.append(words, caret);
    row.append(button);
    host.prepend(row);
    host.classList.add("settings-fold-host");
    body.classList.add("settings-fold-body");
    function setOpen(open) {
        host.toggleAttribute("data-settings-open", open);
        button.setAttribute("aria-expanded", String(open));
    }
    const fold = { row, button, summary,
        open: () => {
            for (const peer of options.peers ?? [])
                if (peer !== fold)
                    peer.close();
            setOpen(true);
        },
        close: () => setOpen(false),
    };
    setOpen(!!options.open);
    options.peers?.push(fold);
    folds.set(target, fold);
    folds.set(body, fold);
    button.addEventListener("click", () => {
        if (host.hasAttribute("data-settings-open"))
            fold.close();
        else
            fold.open();
    }, { signal });
    signal.addEventListener("abort", () => {
        folds.delete(target);
        folds.delete(body);
        row.remove();
        host.classList.remove("settings-fold-host");
        body.classList.remove("settings-fold-body");
        host.removeAttribute("data-settings-open");
        if (!initialId)
            body.removeAttribute("id");
    }, { once: true });
    return fold;
}
export function revealSettingsFold(target) {
    const fold = folds.get(target);
    if (!fold?.button.getClientRects().length)
        return;
    fold.open();
    return fold.button;
}
function openInvalidField(event) {
    const panels = [];
    for (let element = event.target; element; element = element.parentElement) {
        if (element instanceof HTMLElement && element.classList.contains("settings-fold-body"))
            panels.unshift(element);
    }
    for (const panel of panels)
        revealSettingsFold(panel);
}
export function settingsHelpText(source) {
    if (source instanceof HTMLInputElement)
        return [source.placeholder];
    if (source instanceof HTMLSelectElement)
        return [...source.options].map(option => option.text);
    const paragraphs = source?.querySelectorAll("p,.help-line,li");
    return paragraphs?.length ? [...paragraphs].map(node => node.textContent.trim()) : [source?.textContent?.trim() || ""];
}
export function createSettingsHelp(container, signal) {
    const mobile = matchMedia("(max-width: 760px)");
    const popup = document.createElement("div");
    popup.id = "settings-mobile-help";
    popup.className = "settings-help-popup";
    popup.popover = "auto";
    popup.setAttribute("role", "dialog");
    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.id = popup.id + "-title";
    popup.setAttribute("aria-labelledby", title.id);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "dlg-x";
    setAttrRender(close, "aria-label", () => t("关闭"));
    close.append(svgIcon("close", 16));
    const text = document.createElement("div");
    text.className = "settings-help-text";
    header.append(title, close);
    popup.append(header, text);
    container.append(popup);
    let active;
    const triggers = [];
    function hide() {
        if (popup.matches(":popover-open"))
            popup.hidePopover();
    }
    close.addEventListener("click", hide, { signal });
    popup.addEventListener("beforetoggle", event => {
        if (event.newState === "closed") {
            active?.setAttribute("aria-expanded", "false");
            active = undefined;
        }
    }, { signal });
    mobile.addEventListener("change", hide, { signal });
    bus.addEventListener("navigation-changed", hide, { signal });
    bus.addEventListener("view-changed", hide, { signal });
    container.addEventListener("invalid", openInvalidField, { capture: true, signal });
    signal.addEventListener("abort", () => {
        hide();
        for (const trigger of triggers)
            trigger.remove();
        popup.remove();
    }, { once: true });
    return (host, label, read) => {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "settings-help-trigger settings-mobile-only";
        trigger.setAttribute("aria-controls", popup.id);
        trigger.setAttribute("aria-expanded", "false");
        setAttrRender(trigger, "aria-label", () => t("了解更多") + " · " + label());
        trigger.append(svgIcon("help", 20));
        host.append(trigger);
        triggers.push(trigger);
        trigger.addEventListener("click", () => {
            if (active === trigger) {
                hide();
                return;
            }
            if (active)
                hide();
            title.textContent = label();
            text.replaceChildren(...read().filter(Boolean).map(value => {
                const paragraph = document.createElement("p");
                paragraph.textContent = value;
                return paragraph;
            }));
            active = trigger;
            trigger.setAttribute("aria-expanded", "true");
            popup.showPopover({ source: trigger });
            close.focus({ preventScroll: true });
        }, { signal });
    };
}
