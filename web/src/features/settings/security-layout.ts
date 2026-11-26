import { setAttrRender, setText, t } from "../../i18n.js";
import { svgIcon, type IconSlot } from "../../icons.js";
import { bus } from "../../state.js";

export function initSecurityLayout(section: HTMLElement, signal: AbortSignal) {
  const mobile = matchMedia("(max-width: 760px)");
  const groups = [...section.querySelectorAll<HTMLElement>(":scope > [data-settings-topic]")];
  const disclosures = [...section.querySelectorAll<HTMLElement>("[data-security-disclosure]")];
  const headings = new Map<HTMLElement, { row: HTMLElement; button: HTMLButtonElement; summary: HTMLElement }>();

  function setOpen(group: HTMLElement, open: boolean) {
    group.toggleAttribute("data-security-open", open);
    headings.get(group)!.button.setAttribute("aria-expanded", String(open));
  }

  for (const group of [...groups, ...disclosures]) {
    const main = groups.includes(group);
    const body = group.querySelector<HTMLElement>(":scope > .settings-block, :scope > .security-disclosure-body")!;
    const row = document.createElement("div");
    row.className = "security-fold-row security-mobile-only";
    if (main) {
      row.setAttribute("role", "heading");
      row.setAttribute("aria-level", "3");
    }
    if (group.dataset.securityDisclosureHelp) row.dataset.securityHelp = group.dataset.securityDisclosureHelp;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "security-fold";
    button.setAttribute("aria-controls", body.id);
    const words = document.createElement("span");
    const label = document.createElement("span");
    const summary = document.createElement("small");
    summary.className = "security-group-summary";
    const source = group.dataset.securityDisclosure ?? group.querySelector("h3")?.dataset.i18n;
    if (source) setText(label, source);
    words.append(label);
    if (main) words.append(summary);
    const icon = group.dataset.settingsTopicIcon as IconSlot | undefined;
    if (icon) button.append(svgIcon(icon, 17));
    const caret = svgIcon("chevron", 14);
    caret.classList.add("security-fold-caret");
    button.append(words, caret);
    row.append(button);
    group.prepend(row);
    headings.set(group, { row, button, summary });
    setOpen(group, group === groups[0]);
    button.addEventListener("click", () => {
      const open = !group.hasAttribute("data-security-open");
      if (main && open) {
        for (const other of groups) if (other !== group) setOpen(other, false);
      }
      setOpen(group, open);
    }, { signal });
  }

  const helpers = [...section.querySelectorAll<HTMLElement>("[data-security-help]")];
  const help = helpers.map((host, index) => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "security-help-trigger security-mobile-only";
    const label = () => host.firstElementChild?.textContent?.trim() || t("了解更多");
    setAttrRender(trigger, "aria-label", () => t("了解更多") + " · " + label());
    trigger.append(svgIcon("help", 20));
    const popup = document.createElement("div");
    popup.className = "security-help-popup";
    popup.id = "security-help-" + (index + 1);
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
    close.popoverTargetElement = popup;
    close.popoverTargetAction = "hide";
    close.autofocus = true;
    header.append(title, close);
    const text = document.createElement("div");
    text.className = "security-help-text";
    popup.append(header, text);
    host.append(trigger);
    section.append(popup);
    trigger.popoverTargetElement = popup;
    trigger.setAttribute("aria-controls", popup.id);
    trigger.setAttribute("aria-expanded", "false");
    popup.addEventListener("beforetoggle", event => {
      const open = (event as ToggleEvent).newState === "open";
      trigger.setAttribute("aria-expanded", String(open));
      if (!open) return;
      title.textContent = label();
      const paragraphs = host.dataset.securityHelp!.split(" ").flatMap(id => {
        const source = document.getElementById(id);
        if (source instanceof HTMLInputElement) return [source.placeholder];
        if (source instanceof HTMLSelectElement) return [...source.options].map(option => option.text);
        const parts = source?.querySelectorAll("p");
        return parts?.length ? [...parts].map(node => node.textContent.trim()) : [source?.textContent?.trim() || ""];
      });
      text.replaceChildren(...paragraphs.filter(Boolean).map(value => {
        const paragraph = document.createElement("p");
        paragraph.textContent = value;
        return paragraph;
      }));
    }, { signal });
    return { trigger, popup };
  });

  function closeHelp() {
    for (const { popup } of help) if (popup.matches(":popover-open")) popup.hidePopover();
  }
  mobile.addEventListener("change", closeHelp, { signal });
  bus.addEventListener("navigation-changed", closeHelp, { signal });
  bus.addEventListener("view-changed", closeHelp, { signal });

  const list = section.querySelector("#user-list")!;
  const tunnel = section.querySelector<HTMLInputElement>("#set-tunnel-on")!;
  const limit = section.querySelector<HTMLInputElement>("#set-upload")!;
  const [userSummary, tunnelSummary, uploadSummary] = groups.map(group => headings.get(group)!.summary);
  const refresh = () => {
    const count = list.querySelectorAll(".user-row:not([aria-hidden])").length;
    setText(userSummary, "用户数 · {p0}", { p0: String(count) });
    setText(tunnelSummary, tunnel.checked ? "隧道已开启" : "隧道已关闭");
    setText(uploadSummary, limit.value ? "上传上限 · {p0} MB" : "上传与监听", { p0: limit.value });
  };
  refresh();
  const users = new MutationObserver(refresh);
  users.observe(list, { childList: true });
  section.addEventListener("input", refresh, { signal });
  section.addEventListener("change", refresh, { signal });
  signal.addEventListener("abort", () => {
    closeHelp();
    users.disconnect();
    for (const { trigger, popup } of help) { trigger.remove(); popup.remove(); }
    for (const [group, { row }] of headings) { group.removeAttribute("data-security-open"); row.remove(); }
  }, { once: true });
  return refresh;
}
