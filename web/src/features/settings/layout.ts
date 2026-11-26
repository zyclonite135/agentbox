import { setAttr, setText } from "../../i18n.js";
import { svgIcon, type IconSlot } from "../../icons.js";
import { revealSettingsFold, type AddSettingsHelp } from "./mobile-layout.js";
import { initMobileSettingsSections } from "./mobile-sections.js";

function observeSettingsStrip(viewport: HTMLElement, items: HTMLElement[], signal: AbortSignal) {
  const [first] = items;
  const last = items.at(-1);
  if (!first || !last) return;
  const updateEdges = () => {
    const bounds = viewport.getBoundingClientRect();
    viewport.toggleAttribute("data-overflow-left", first.getBoundingClientRect().left < bounds.left - 1);
    viewport.toggleAttribute("data-overflow-right", last.getBoundingClientRect().right > bounds.right + 1);
  };
  const observer = new ResizeObserver(updateEdges);
  observer.observe(viewport);
  for (const item of items) observer.observe(item);
  viewport.addEventListener("scroll", updateEdges, { passive: true, signal });
  viewport.addEventListener("focusin", ({ target }) => {
    if (target instanceof HTMLButtonElement && target.matches(":focus-visible")) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, { signal });
  signal.addEventListener("abort", () => {
    observer.disconnect();
    viewport.removeAttribute("data-overflow-left");
    viewport.removeAttribute("data-overflow-right");
  }, { once: true });
}

/** Present the existing settings and table rows without changing their handlers. */
export function initSettingsLayout(content: HTMLElement, signal: AbortSignal, addHelp: AddSettingsHelp) {
  for (const section of content.querySelectorAll<HTMLElement>(":scope > .set-section")) {
    const topics = [...section.querySelectorAll<HTMLElement>(":scope > [data-settings-topic]")];
    const intro = section.querySelector(":scope > .sec-intro");
    if (topics.length < 2 || !intro) continue;
    const jumps = document.createElement("nav");
    jumps.className = "settings-jumps";
    setAttr(jumps, "aria-label", "本节导航");
    const row = document.createElement("div");
    row.className = "settings-jumps-row";
    jumps.append(row);
    for (const topic of topics) {
      const title = topic.querySelector<HTMLElement>("h3");
      const source = topic.dataset.settingsTopic || title?.dataset.i18n;
      if (!source) continue;
      const button = document.createElement("button");
      button.type = "button";
      const icon = topic.dataset.settingsTopicIcon as IconSlot | undefined;
      if (icon) button.append(svgIcon(icon, 16));
      const caption = document.createElement("span");
      setText(caption, source);
      button.append(caption);
      if (topic.id) button.setAttribute("aria-controls", topic.id);
      button.addEventListener("click", () => {
        const mobileFold = revealSettingsFold(topic);
        const destination = mobileFold ?? title ?? topic;
        if (!mobileFold) destination.tabIndex = -1;
        destination.focus({preventScroll:true});
        content.scrollTop += (mobileFold ?? topic).getBoundingClientRect().top - content.getBoundingClientRect().top;
      }, {signal});
      row.append(button);
    }
    intro.after(jumps);
    observeSettingsStrip(jumps, [row], signal);
    signal.addEventListener("abort", () => jumps.remove(), { once: true });
  }

  const modelTabs = content.querySelector<HTMLElement>(".mdl-tabs");
  if (modelTabs) observeSettingsStrip(modelTabs, [...modelTabs.querySelectorAll("button")], signal);
  initMobileSettingsSections(content, signal, addHelp);

  const tables = content.querySelectorAll<HTMLTableElement>(".mon-table, .price-table, .component-table");
  function labelRows(table: HTMLTableElement) {
    const header = table.tHead?.rows[0];
    if (!header) return;
    const labels = [...header.cells].flatMap(cell => Array<string>(cell.colSpan).fill(cell.textContent?.trim() || ""));
    for (const body of table.tBodies) {
      for (const row of body.rows) {
        let column = 0;
        for (const cell of row.cells) {
          if (cell.tagName === "TD" && cell.colSpan === 1 && labels[column]) cell.dataset.settingsColumn = labels[column];
          else delete cell.dataset.settingsColumn;
          column += cell.colSpan;
        }
      }
    }
  }
  const observer = new MutationObserver(records => {
    const changed = new Set<HTMLTableElement>();
    for (const {target} of records) {
      const element = target instanceof Element ? target : target.parentElement;
      const table = element?.closest<HTMLTableElement>("table[data-settings-table]");
      if (table) changed.add(table);
    }
    for (const table of changed) labelRows(table);
  });
  for (const table of tables) {
    table.setAttribute("data-settings-table", "");
    labelRows(table);
    observer.observe(table, {childList:true, characterData:true, subtree:true});
  }
  signal.addEventListener("abort", () => observer.disconnect(), {once:true});
}
