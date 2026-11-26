import { setAttr, setText } from "../../i18n.js";
import { svgIcon, type IconSlot } from "../../icons.js";

/** Present the existing settings and table rows without changing their handlers. */
export function initSettingsLayout(content: HTMLElement, signal: AbortSignal) {
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
        const fold = topic.querySelector<HTMLButtonElement>(":scope > .security-fold-row > .security-fold");
        const mobileFold = fold?.getClientRects().length ? fold : undefined;
        if (mobileFold?.getAttribute("aria-expanded") === "false") mobileFold.click();
        const destination = mobileFold ?? title ?? topic;
        if (!mobileFold) destination.tabIndex = -1;
        destination.focus({preventScroll:true});
        content.scrollTop += topic.getBoundingClientRect().top - content.getBoundingClientRect().top;
      }, {signal});
      row.append(button);
    }
    intro.after(jumps);

    const updateEdges = () => {
      const viewport = jumps.getBoundingClientRect();
      const track = row.getBoundingClientRect();
      jumps.toggleAttribute("data-overflow-left", track.left < viewport.left - 1);
      jumps.toggleAttribute("data-overflow-right", track.right > viewport.right + 1);
    };
    const resize = new ResizeObserver(updateEdges);
    resize.observe(jumps);
    resize.observe(row);
    jumps.addEventListener("scroll", updateEdges, {passive:true, signal});
    jumps.addEventListener("focusin", ({target}) => {
      if (target instanceof HTMLButtonElement && target.matches(":focus-visible")) {
        target.scrollIntoView({block:"nearest", inline:"nearest"});
      }
    }, {signal});
    signal.addEventListener("abort", () => {
      resize.disconnect();
      jumps.remove();
    }, {once:true});
  }

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
