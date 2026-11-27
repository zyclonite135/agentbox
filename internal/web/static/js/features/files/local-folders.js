import { api } from "../../api.js";
import { actionButton, fileIconName, svgIcon } from "../../icons.js";
import { setAttrRender, setText, t } from "../../i18n.js";
import { closeMenu, moreButton } from "../../menu.js";
import { setTip } from "../../tip.js";
import { bus, emit, S } from "../../state.js";
import { Poller } from "../../shared/poller.js";
import { $, btnBusy, btnDone, fmtSize, toast } from "../../util.js";
const panel = $("local-files");
const tab = $("tab-files");
const scope = $("scope-local");
const list = $("local-files-list");
const status = $("local-files-status");
const toolbar = $("local-files-toolbar");
const breadcrumb = $("local-files-path");
const connection = $("local-files-connection");
const head = $("local-files-head");
const scroller = $("local-files-scroll");
const more = $("local-files-more");
const refresh = $("local-files-refresh");
const headers = { "X-AgentBox-Local-Files": "1" };
const watcher = new Poller();
let browse;
let transfer;
let owner = "";
let session = "";
let catalog;
let selected;
let directory = "";
let next = 0;
let catalogError = false;
const active = () => tab.classList.contains("show-local-files") && owner === S.token && session === S.current?.id;
function closeFileMenu() {
    if (list.querySelector('.local-file-more[aria-expanded="true"]'))
        closeMenu();
}
export function closeLocalFiles() {
    if (!tab.classList.contains("show-local-files"))
        return;
    watcher.stop();
    closeFileMenu();
    browse?.abort();
    transfer?.abort();
    browse = transfer = undefined;
    selected = catalog = undefined;
    directory = owner = session = "";
    next = 0;
    catalogError = false;
    tab.classList.remove("show-local-files");
    scope.classList.remove("active");
    $("scope-ws").classList.toggle("active", S.fileScope === "workspace");
    $("scope-shared").classList.toggle("active", S.fileScope === "shared");
    panel.hidden = toolbar.hidden = connection.hidden = true;
    list.replaceChildren();
    breadcrumb.replaceChildren();
}
function showMessage(message = "") {
    status.hidden = !message;
    setText(status, message);
}
function renderConnection(online) {
    const caption = document.createElement("span");
    setText(caption, online ? "只读访问" : "本机离线");
    connection.classList.toggle("offline", !online);
    connection.replaceChildren(svgIcon(online ? "lock" : "desktop", 14), caption);
    connection.hidden = false;
}
function renderPath() {
    breadcrumb.replaceChildren();
    breadcrumb.hidden = !selected;
    if (!selected)
        return;
    const folder = selected;
    const root = document.createElement("button");
    root.type = "button";
    root.className = "local-path-root";
    root.append(svgIcon("desktop", 15));
    setAttrRender(root, "aria-label", () => t("本机文件"));
    setTip(root, () => t("本机文件"));
    root.addEventListener("click", () => openDirectory(undefined, "", true));
    breadcrumb.append(root);
    const separator = () => {
        const arrow = svgIcon("chevron-right", 12);
        arrow.classList.add("local-path-separator");
        return arrow;
    };
    const parts = directory.split("/").filter(Boolean);
    const current = parts.pop() ?? folder.name;
    const trail = document.createElement("span");
    if (directory) {
        parts.unshift(folder.name);
        trail.className = "local-path-trail";
        let path = "";
        parts.forEach((name, index) => {
            if (index)
                path = path ? path + "/" + name : name;
            const target = path;
            const part = document.createElement("button");
            part.type = "button";
            part.textContent = name;
            setTip(part, name);
            part.addEventListener("click", () => openDirectory(folder.id, target, true));
            trail.append(separator(), part);
        });
        breadcrumb.append(trail);
    }
    const last = document.createElement("span");
    last.className = "local-path-current";
    last.textContent = current;
    last.setAttribute("aria-current", "page");
    last.tabIndex = -1;
    setTip(last, current);
    breadcrumb.append(separator(), last);
    trail.scrollLeft = trail.scrollWidth;
    return last;
}
function openDirectory(folderID, path = "", focusPath = false) {
    const folder = catalog?.folders.find(item => item.id === folderID);
    selected = folder;
    directory = path;
    if (folder) {
        panel.classList.remove("local-files-catalog");
        const current = renderPath();
        void loadDirectory();
        if (focusPath)
            current?.focus();
    }
    else {
        browse?.abort();
        renderCatalog();
        if (focusPath)
            scope.focus();
    }
}
function rowName(name, icon, size = "") {
    const cell = document.createElement("span");
    cell.className = "fname";
    const glyph = document.createElement("span");
    glyph.className = "fglyph";
    glyph.append(svgIcon(icon, 15));
    const text = document.createElement("span");
    text.className = "ftext";
    const label = document.createElement("span");
    label.className = "flabel";
    label.textContent = name;
    setTip(label, name);
    text.append(label);
    if (size) {
        const sub = document.createElement("span");
        sub.className = "fsub";
        sub.textContent = size;
        text.append(sub);
    }
    cell.append(glyph, text);
    return cell;
}
function directoryRow(name, open, disabled = false) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row dir local-file-directory";
    row.disabled = disabled;
    const contents = rowName(name, "file.folder");
    const arrow = svgIcon("chevron-right", 14);
    arrow.classList.add("local-folder-arrow");
    contents.append(arrow);
    row.append(contents);
    row.addEventListener("click", event => open(event.detail === 0));
    return row;
}
function renderCatalog() {
    closeFileMenu();
    list.replaceChildren();
    panel.classList.add("local-files-catalog");
    next = 0;
    more.hidden = true;
    renderPath();
    const folders = catalog?.folders ?? [];
    head.hidden = !folders.length;
    showMessage(folders.length ? "" : "请在 abox-link 中添加本机文件夹并启动连接。");
    for (const folder of folders) {
        list.append(directoryRow(folder.name, keyboard => openDirectory(folder.id, "", keyboard), !catalog?.online));
    }
}
async function refreshCatalog(signal) {
    try {
        const current = await api("/local-folders", { headers, signal });
        if (signal.aborted || !active())
            return;
        const changed = JSON.stringify(current) !== JSON.stringify(catalog);
        const recovered = catalogError;
        catalog = current;
        catalogError = false;
        if (changed || recovered)
            renderConnection(current.online);
        if (selected) {
            const folder = current.online ? current.folders.find(item => item.id === selected?.id) : undefined;
            if (!folder) {
                browse?.abort();
                selected = undefined;
                directory = "";
            }
            else if (folder.name !== selected.name) {
                const hadPathFocus = breadcrumb.contains(document.activeElement);
                selected = folder;
                const current = renderPath();
                if (hadPathFocus)
                    current?.focus({ preventScroll: true });
            }
        }
        if ((changed || recovered) && !selected)
            renderCatalog();
    }
    catch {
        if (!signal.aborted && active() && !selected) {
            catalogError = true;
            showMessage("无法读取本机文件");
        }
    }
}
async function loadDirectory(offset = 0) {
    if (!selected)
        return;
    browse?.abort();
    const controller = browse = new AbortController();
    const folder = selected;
    const here = directory;
    const params = new URLSearchParams({ path: here || ".", offset: String(offset) });
    more.hidden = true;
    if (!offset) {
        closeFileMenu();
        next = 0;
        head.hidden = true;
        list.replaceChildren();
        scroller.scrollTop = 0;
    }
    showMessage("正在加载…");
    try {
        const page = await api(`/local-folders/${folder.id}?${params}`, { headers, signal: controller.signal });
        if (controller.signal.aborted || !active())
            return;
        for (const entry of page.entries ?? [])
            addEntry(folder, here, entry);
        next = page.next ?? 0;
        more.hidden = !next;
        head.hidden = !list.childElementCount;
        showMessage(list.childElementCount || next ? "" : "此文件夹为空");
    }
    catch {
        if (!controller.signal.aborted && active()) {
            more.hidden = !next;
            showMessage("无法读取本机文件");
        }
    }
}
function fileButton(label, icon, run) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "file-act desktop-only";
    setAttrRender(control, "aria-label", () => t(label));
    setTip(control, () => t(label));
    control.append(svgIcon(icon, 16));
    control.addEventListener("click", () => run(control));
    return control;
}
function addEntry(folder, parent, entry) {
    const path = parent ? parent + "/" + entry.name : entry.name;
    if (entry.directory) {
        list.append(directoryRow(entry.name, keyboard => openDirectory(folder.id, path, keyboard)));
        return;
    }
    const row = document.createElement("div");
    row.className = "file-row";
    const size = fmtSize(entry.size);
    const sizeCell = document.createElement("span");
    sizeCell.className = "fsize";
    sizeCell.textContent = size;
    const actions = document.createElement("span");
    actions.className = "factions local-file-actions";
    const copyLabel = "复制到工作空间";
    const attachLabel = "附加到对话";
    const attach = () => emit("local-file-attach", { name: entry.name, folder: folder.id, path });
    const copy = (target) => void copyFile(target, folder.id, path);
    const menu = moreButton(() => [
        { label: t(copyLabel), icon: "copy", run: () => copy(menu), disabled: !!transfer },
        { label: t(attachLabel), icon: "composer.attach", run: attach },
    ]);
    menu.classList.add("local-file-more");
    actions.append(fileButton(copyLabel, "copy", copy), fileButton(attachLabel, "composer.attach", attach), menu);
    row.append(rowName(entry.name, fileIconName(entry.name), size), sizeCell, actions);
    list.append(row);
}
async function copyFile(target, folder, path) {
    if (transfer)
        return;
    const controller = transfer = new AbortController();
    btnBusy(target, () => t("正在复制…"));
    try {
        await api(`/sessions/${session}/local-file`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ folder, path }), signal: controller.signal,
        });
        if (!controller.signal.aborted && active())
            toast(t("已复制到工作空间"));
    }
    catch (error) {
        if (!controller.signal.aborted && active()) {
            const message = error.message;
            toast(t(message === "a file with that name already exists in the workspace" ? "工作空间中已有同名文件" : "无法复制本机文件"), true);
        }
    }
    finally {
        if (transfer === controller)
            transfer = undefined;
        btnDone(target);
    }
}
actionButton(refresh, "", "refresh", () => t("刷新"));
scope.addEventListener("click", () => {
    if (!S.current || active())
        return;
    owner = S.token;
    session = S.current.id;
    tab.classList.remove("drag-over");
    tab.classList.add("show-local-files");
    scope.classList.add("active");
    $("scope-ws").classList.remove("active");
    $("scope-shared").classList.remove("active");
    head.hidden = more.hidden = true;
    panel.hidden = toolbar.hidden = false;
    renderPath();
    showMessage("正在加载…");
    watcher.start(5000, refreshCatalog);
});
refresh.addEventListener("click", () => {
    watcher.start(5000, refreshCatalog);
    if (selected)
        void loadDirectory();
});
more.addEventListener("click", () => { if (next)
    void loadDirectory(next); });
bus.addEventListener("signed-out", closeLocalFiles);
for (const event of ["navigation-changed", "view-changed"]) {
    bus.addEventListener(event, () => { if (!active() || S.tab !== "files" || S.view !== "work")
        closeLocalFiles(); });
}
