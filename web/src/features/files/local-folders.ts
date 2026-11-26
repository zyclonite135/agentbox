import { api } from "../../api.js";
import { actionButton } from "../../icons.js";
import { setText, t } from "../../i18n.js";
import { bus, emit, S } from "../../state.js";
import { Poller } from "../../shared/poller.js";
import { $, btnBusy, btnDone, fmtSize, toast } from "../../util.js";

interface Folder { id: string; name: string }
interface Entry { name: string; directory: boolean; size: number }
interface Catalog { folders: Folder[]; online: boolean }
interface FolderPage { entries?: Entry[]; next?: number }

const panel = $("local-files");
const tab = $("tab-files");
const scope = $("scope-local");
const list = $("local-files-list");
const status = $("local-files-status");
const back = $<HTMLButtonElement>("local-files-back");
const more = $<HTMLButtonElement>("local-files-more");
const refresh = $<HTMLButtonElement>("local-files-refresh");
const headers = { "X-AgentBox-Local-Files": "1" };
const watcher = new Poller();
let browse: AbortController | undefined;
let transfer: AbortController | undefined;
let owner = "";
let session = "";
let catalog: Catalog | undefined;
let selected: Folder | undefined;
let directory = "";
let next = 0;

const active = () => tab.classList.contains("show-local-files") && owner === S.token && session === S.current?.id;

export function closeLocalFiles() {
  if (!tab.classList.contains("show-local-files")) return;
  watcher.stop();
  browse?.abort();
  transfer?.abort();
  browse = transfer = undefined;
  selected = catalog = undefined;
  directory = owner = session = "";
  next = 0;
  tab.classList.remove("show-local-files");
  scope.classList.remove("active");
  $("scope-ws").classList.toggle("active", S.fileScope === "workspace");
  $("scope-shared").classList.toggle("active", S.fileScope === "shared");
  panel.hidden = true;
  list.replaceChildren();
  status.textContent = "";
  $("local-files-path").textContent = "";
}

function button(label: string, icon: Parameters<typeof actionButton>[2], click: (button: HTMLButtonElement) => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "btn btn-sm";
  actionButton(element, () => t(label), icon);
  element.addEventListener("click", () => click(element));
  return element;
}

function renderCatalog() {
  list.replaceChildren();
  more.hidden = back.hidden = true;
  $("local-files-path").textContent = "";
  if (!catalog?.folders.length) {
    setText(status, "请在 abox-link 中添加本机文件夹并启动连接。");
    return;
  }
  setText(status, catalog.online ? "只读访问" : "本机离线");
  for (const folder of catalog.folders) {
    const row = document.createElement("div");
    row.className = "local-file-row";
    const selection = document.createElement("button");
    selection.type = "button";
    selection.className = "btn btn-ghost local-file-name";
    selection.textContent = folder.name;
    selection.disabled = !catalog.online;
    selection.addEventListener("click", () => {
      selected = folder;
      directory = "";
      void loadDirectory();
    });
    row.append(selection);
    list.append(row);
  }
}

async function refreshCatalog(signal: AbortSignal, showError = false) {
  try {
    const current = await api<Catalog>("/local-folders", { headers, signal });
    if (signal.aborted || !active()) return;
    const changed = JSON.stringify(current) !== JSON.stringify(catalog);
    catalog = current;
    if (!current.online || selected && !current.folders.some(folder => folder.id === selected?.id)) {
      browse?.abort();
      selected = undefined;
      directory = "";
    }
    if (changed && !selected) renderCatalog();
  } catch {
    if (showError && !signal.aborted && active()) setText(status, "无法读取本机文件");
  }
}

async function loadDirectory(offset = 0) {
  if (!selected) return;
  browse?.abort();
  const controller = browse = new AbortController();
  const folder = selected;
  const here = directory;
  const params = new URLSearchParams({ path: here || ".", offset: String(offset) });
  back.hidden = false;
  $("local-files-path").textContent = [folder.name, here].filter(Boolean).join(" / ");
  more.hidden = true;
  if (!offset) list.replaceChildren();
  setText(status, "正在加载…");
  try {
    const page = await api<FolderPage>(`/local-folders/${folder.id}?${params}`, { headers, signal: controller.signal });
    if (controller.signal.aborted || !active()) return;
    for (const entry of page.entries ?? []) addEntry(folder.id, here, entry);
    next = page.next ?? 0;
    more.hidden = !next;
    setText(status, list.childElementCount || next ? "只读访问" : "此文件夹为空");
  } catch {
    if (!controller.signal.aborted && active()) setText(status, "无法读取本机文件");
  }
}

function addEntry(folder: string, parent: string, entry: Entry) {
  const path = parent ? parent + "/" + entry.name : entry.name;
  const row = document.createElement("div");
  row.className = "local-file-row";
  if (entry.directory) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "btn btn-ghost local-file-name";
    item.textContent = entry.name + "/";
    item.addEventListener("click", () => { directory = path; void loadDirectory(); });
    row.append(item);
  } else {
    const name = document.createElement("span");
    name.className = "local-file-name";
    name.textContent = entry.name + " · " + fmtSize(entry.size);
    row.append(name, button("复制到工作空间", "copy", target => void copyFile(target, folder, path)),
      button("附加到对话", "composer.attach", () => emit("local-file-attach", { name: entry.name, folder, path })));
  }
  list.append(row);
}

async function copyFile(target: HTMLButtonElement, folder: string, path: string) {
  if (transfer) return;
  const controller = transfer = new AbortController();
  btnBusy(target, () => t("正在复制…"));
  try {
    await api(`/sessions/${session}/local-file`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ folder, path }), signal: controller.signal,
    });
    if (active()) toast(t("已复制到工作空间"));
  } catch (error) {
    if (!controller.signal.aborted && active()) {
      const message = (error as Error).message;
      toast(t(message === "a file with that name already exists in the workspace" ? "工作空间中已有同名文件" : "无法复制本机文件"), true);
    }
  } finally {
    if (transfer === controller) transfer = undefined;
    btnDone(target);
  }
}

scope.addEventListener("click", () => {
  if (!S.current || active()) return;
  owner = S.token;
  session = S.current.id;
  tab.classList.add("show-local-files");
  scope.classList.add("active");
  $("scope-ws").classList.remove("active");
  $("scope-shared").classList.remove("active");
  panel.hidden = false;
  setText(status, "正在加载…");
  watcher.start(5000, signal => refreshCatalog(signal, true));
});
refresh.addEventListener("click", () => {
  if (selected) void loadDirectory();
  else watcher.start(5000, signal => refreshCatalog(signal, true));
});
back.addEventListener("click", () => {
  if (directory) {
    directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    void loadDirectory();
  } else {
    browse?.abort();
    selected = undefined;
    renderCatalog();
  }
});
more.addEventListener("click", () => { if (next) void loadDirectory(next); });
bus.addEventListener("signed-out", closeLocalFiles);
for (const event of ["navigation-changed", "view-changed"]) {
  bus.addEventListener(event, () => { if (!active() || S.tab !== "files" || S.view !== "work") closeLocalFiles(); });
}
