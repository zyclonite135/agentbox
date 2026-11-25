import { setAttr, setText } from "../../i18n.js";
/** Present the existing settings and table rows without changing their handlers. */
export function initSettingsLayout(content, signal) {
    for (const section of content.querySelectorAll(":scope > .set-section")) {
        const topics = [...section.querySelectorAll(":scope > [data-settings-topic]")];
        const intro = section.querySelector(":scope > .sec-intro");
        if (topics.length < 2 || !intro)
            continue;
        const jumps = document.createElement("nav");
        jumps.className = "settings-jumps";
        setAttr(jumps, "aria-label", "本节导航");
        for (const topic of topics) {
            const title = topic.querySelector("h3");
            const source = topic.dataset.settingsTopic || title?.dataset.i18n;
            if (!source)
                continue;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-sm btn-ghost";
            setText(button, source);
            button.addEventListener("click", () => {
                const destination = title ?? topic;
                destination.tabIndex = -1;
                destination.focus({ preventScroll: true });
                content.scrollTop += topic.getBoundingClientRect().top - content.getBoundingClientRect().top;
            }, { signal });
            jumps.append(button);
        }
        intro.after(jumps);
        signal.addEventListener("abort", () => jumps.remove(), { once: true });
    }
    const tables = content.querySelectorAll(".mon-table, .price-table, .component-table");
    function labelRows(table) {
        const header = table.tHead?.rows[0];
        if (!header)
            return;
        const labels = [...header.cells].flatMap(cell => Array(cell.colSpan).fill(cell.textContent?.trim() || ""));
        for (const body of table.tBodies) {
            for (const row of body.rows) {
                let column = 0;
                for (const cell of row.cells) {
                    if (cell.tagName === "TD" && cell.colSpan === 1 && labels[column])
                        cell.dataset.settingsColumn = labels[column];
                    else
                        delete cell.dataset.settingsColumn;
                    column += cell.colSpan;
                }
            }
        }
    }
    const observer = new MutationObserver(records => {
        const changed = new Set();
        for (const { target } of records) {
            const element = target instanceof Element ? target : target.parentElement;
            const table = element?.closest("table[data-settings-table]");
            if (table)
                changed.add(table);
        }
        for (const table of changed)
            labelRows(table);
    });
    for (const table of tables) {
        table.setAttribute("data-settings-table", "");
        labelRows(table);
        observer.observe(table, { childList: true, characterData: true, subtree: true });
    }
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
}
