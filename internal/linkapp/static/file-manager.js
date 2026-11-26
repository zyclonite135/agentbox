const icons = {
  computer: "M3 4h18v13H3zM8 21h8m-4-4v4",
  workspace: "M3 7l9-4 9 4-9 4zm0 5 9 4 9-4M3 17l9 4 9-4",
  refresh: "M20 11a8 8 0 1 0-2 6m2-12v6h-6",
  up: "M12 19V5m-6 6 6-6 6 6",
  search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l5 5",
  chevron: "m6 9 6 6 6-6",
  close: "m6 6 12 12M18 6 6 18",
  folder: "M3 7v12h18V7H11L9 4H3z",
  file: "M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h8",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 5M15 8h.01",
  sheet: "M5 3h10l4 4v14H5zM8 11h8m-8 4h8m-4-4v8M15 3v5h4",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  upload: "M12 17V4m-5 5 5-5 5 5M4 17v4h16v-4",
  download: "M12 4v13m-5-5 5 5 5-5M4 17v4h16v-4",
};

const $ = id => document.getElementById(id);
const at = (side, item) => $("fm-" + side + "-" + item);
const create = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.65", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(key, value);
  }
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", icons[name]);
  svg.append(shape);
  return svg;
}

const pathOf = parts => parts.length ? parts.join("/") : ".";
const fileAt = (parts, name) => [...parts, name].join("/");
const otherSide = side => side === "local" ? "remote" : "local";
const imageFile = name => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

function availableCopyName(name, number) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) + " (" + number + ")" + name.slice(i) : name + " (" + number + ")";
}

export function createFileManager({ tr, locale, errorMessage, toast, pickManualFolder }) {
  const state = {
    local: { roots: [], root: "", parts: [], entries: [], selected: new Set(), descending: false },
    remote: { roots: [], root: "", parts: [], entries: [], selected: new Set(), descending: false },
  };
  let accountKey = "", folderKey = "", ready = false, processing = false, dragged = null, pickerBusy = false;
  let previewURL, previewRequest, activeDialog;
  const jobs = [];
  const sides = ["local", "remote"];
  const dialog = $("fm-dialog");

  for (const el of document.querySelectorAll("[data-fm-icon]")) el.append(icon(el.dataset.fmIcon));

  async function send(endpoint, { body, query, signal } = {}) {
    const params = query ? "?" + new URLSearchParams(query) : "";
    const res = await fetch("/api/file-manager/" + endpoint + params, {
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: { "X-Abox-Panel": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "文件操作失败");
    }
    return res;
  }

  function visibleEntries(side) {
    const pane = state[side];
    const filter = at(side, "filter").value.trim().toLocaleLowerCase(locale());
    const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
    return pane.entries.filter(entry => entry.name.toLocaleLowerCase(locale()).includes(filter))
      .sort((a, b) => a.directory !== b.directory ? Number(b.directory) - Number(a.directory) :
        collator.compare(a.name, b.name) * (pane.descending ? -1 : 1));
  }

  function renderRoots(side) {
    const pane = state[side];
    const select = at(side, "root");
    const hint = side === "local" ? "本机文件夹" : "选择工作空间";
    const options = pane.roots.map(root => new Option(root.name, root.id));
    select.replaceChildren(...(options.length ? options : [new Option(tr(hint), "")]));
    select.value = pane.root;
    select.disabled = options.length === 0;
  }

  async function readRoots() {
    const currentAccount = accountKey;
    const pane = state.remote;
    pane.rootsRequest?.abort();
    const controller = new AbortController();
    pane.rootsRequest = controller;
    pane.loadingRoots = true;
    pane.error = "";
    renderRows("remote");
    renderSelection("local");
    try {
      const roots = await (await send("workspaces", { signal: controller.signal })).json();
      if (controller.signal.aborted || accountKey !== currentAccount) return;
      pane.roots = roots.filter(root => root.id && root.name);
      const next = pane.roots.some(root => root.id === pane.root) ? pane.root : pane.roots[0]?.id || "";
      const changed = next !== pane.root;
      pane.root = next;
      pane.loadingRoots = false;
      renderRoots("remote");
      if (changed) navigate("remote", []);
      else await list("remote", pane.parts, true);
    } catch (error) {
      if (controller.signal.aborted || accountKey !== currentAccount) return;
      pane.loadingRoots = false;
      pane.error = error.message;
      renderRows("remote");
      renderSelection("local");
    }
  }

  function entryQuery(side, name) {
    return {
      [side === "local" ? "folder" : "workspace"]: state[side].root,
      path: name,
    };
  }

  async function list(side, parts = state[side].parts, preserveSelection = false) {
    const pane = state[side];
    pane.request?.abort();
    const controller = new AbortController();
    pane.request = controller;
    pane.parts = parts;
    if (!preserveSelection) {
      pane.entries = [];
      pane.selected.clear();
    }
    pane.error = "";
    pane.loading = !!pane.root;
    renderRows(side);
    renderSelection(otherSide(side));
    if (!pane.root) return;
    try {
      const result = await (await send(side, { query: entryQuery(side, pathOf(parts)), signal: controller.signal })).json();
      if (!controller.signal.aborted) {
        pane.entries = result;
        const files = new Set(result.filter(entry => !entry.directory).map(entry => entry.name));
        for (const name of pane.selected) if (!files.has(name)) pane.selected.delete(name);
      }
    } catch (error) {
      if (!controller.signal.aborted) pane.error = error.message;
    } finally {
      if (!controller.signal.aborted) {
        pane.loading = false;
        renderRows(side);
        renderSelection(otherSide(side));
      }
    }
  }

  function navigate(side, parts) {
    if (previewRequest?.side === side) previewRequest.controller.abort();
    if (dragged?.side === side) clearDrag();
    at(side, "filter").value = "";
    void list(side, parts);
  }

  function formattedSize(size) {
    if (size == null || size < 0) return "—";
    let number = size, unit = "B";
    for (const next of ["KB", "MB", "GB", "TB"]) {
      if (number < 1024) break;
      number /= 1024;
      unit = next;
    }
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: unit === "B" ? 0 : 1 }).format(number) + " " + unit;
  }

  function renderRows(side) {
    const pane = state[side];
    const rows = visibleEntries(side);
    const notice = pane.error ? errorMessage(pane.error) :
      pane.loading || pane.loadingRoots ? tr("正在读取文件…") :
      !pane.root ? tr(side === "local" ? "添加文件夹以查看文件" : "没有可用的工作空间") :
      !rows.length ? tr(at(side, "filter").value ? "未找到匹配的文件" : "文件夹为空") : "";
    at(side, "notice").textContent = notice;
    const rendered = document.createDocumentFragment();
    for (const entry of rows) rendered.append(fileRow(side, entry));
    at(side, "list").replaceChildren(rendered);
    at(side, "back").disabled = !pane.root || !pane.parts.length;
    at(side, "filter").disabled = !pane.root;
    at(side, "sort").dataset.descending = String(pane.descending);
    const crumbs = at(side, "crumbs");
    crumbs.replaceChildren();
    if (pane.root) {
      const label = pane.roots.find(root => root.id === pane.root)?.name || "…";
      const parts = [label, ...pane.parts];
      for (const [index, text] of parts.entries()) {
        if (index) crumbs.append(create("span", "", "›"));
        const crumb = create("button", "", text);
        crumb.type = "button";
        if (index === parts.length - 1) crumb.setAttribute("aria-current", "page");
        crumb.addEventListener("click", () => navigate(side, pane.parts.slice(0, index)));
        crumbs.append(crumb);
      }
      crumbs.scrollLeft = crumbs.scrollWidth;
    }
    if (side === "remote") $("fm-mkdir").disabled = !pane.root || pane.loading || !!pane.error;
    renderSelection(side, rows);
  }

  function renderSelection(side, rows = visibleEntries(side)) {
    const pane = state[side];
    const all = at(side, "all");
    const files = rows.filter(row => !row.directory);
    const selectedHere = files.filter(row => pane.selected.has(row.name)).length;
    all.checked = files.length > 0 && selectedHere === files.length;
    all.indeterminate = selectedHere > 0 && selectedHere < files.length;
    all.disabled = files.length === 0;
    at(side, "count").textContent = pane.selected.size ?
      tr("已选择 {count} 个文件", { count: pane.selected.size }) :
      tr("{count} 个项目", { count: rows.length });
    const other = state[otherSide(side)];
    at(side, "copy").disabled = !pane.selected.size || !other.root || other.loading || other.loadingRoots || !!other.error || pane.loading || pane.loadingRoots || !!pane.error;
  }

  function fileRow(side, entry) {
    const pane = state[side];
    const li = create("li", "fm-row");
    li.classList.toggle("is-selected", pane.selected.has(entry.name));
    const choose = entry.directory ? create("span") : create("input");
    if (!entry.directory) {
      choose.type = "checkbox";
      choose.checked = pane.selected.has(entry.name);
      choose.setAttribute("aria-label", tr("选择 {name}", { name: entry.name }));
      choose.addEventListener("change", () => {
        if (choose.checked) pane.selected.add(entry.name);
        else pane.selected.delete(entry.name);
        li.classList.toggle("is-selected", choose.checked);
        renderSelection(side);
      });
      li.draggable = true;
      li.addEventListener("dragstart", event => {
        dragged = { side, names: pane.selected.has(entry.name) ? [...pane.selected] : [entry.name] };
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-abox-link-file", side);
      });
      li.addEventListener("dragend", clearDrag);
    }

    const image = imageFile(entry.name);
    const item = create(entry.directory || image ? "button" : "span", "fm-item");
    const kind = entry.directory ? "folder" : image ? "image" : /\.(csv|xlsx?|ods)$/i.test(entry.name) ? "sheet" : "file";
    const badge = create("span", "fm-entry-icon");
    badge.dataset.kind = kind;
    badge.append(icon(kind));
    item.append(badge, create("span", "", entry.name));
    if (entry.modified && new Date(entry.modified).getFullYear() > 1) {
      item.title = entry.name + " · " + new Date(entry.modified).toLocaleString(locale());
    }
    if (item.tagName === "BUTTON") {
      item.type = "button";
      item.addEventListener("click", () => entry.directory ? navigate(side, [...pane.parts, entry.name]) : void preview(side, entry.name));
    }

    const actions = side === "remote" ? create("button", "fm-icon") : create("span");
    if (side === "remote") {
      actions.type = "button";
      actions.title = tr("文件操作");
      actions.setAttribute("aria-label", tr("{name} 的操作", { name: entry.name }));
      actions.append(icon("menu"));
      actions.addEventListener("click", () => void entryActions(entry));
    }
    li.append(choose, item, create("span", "fm-size", entry.directory ? "—" : formattedSize(entry.size)), actions);
    return li;
  }

  function clearDrag() {
    dragged = null;
    for (const side of sides) $("fm-" + side).classList.remove("is-drop-target");
  }

  function ask({ title, text = "", input, actions }) {
    if (activeDialog) return Promise.resolve({ action: "", value: "" });
    const field = $("fm-dialog-input");
    $("fm-dialog-title").textContent = tr(title);
    $("fm-dialog-text").textContent = text;
    $("fm-dialog-label").hidden = input === undefined;
    field.value = input ?? "";
    field.required = input !== undefined;
    $("fm-dialog-input-label").textContent = tr(title);
    const buttons = actions.map(({ label, value, className, cancel }) => {
      const button = create("button", className || "ghost", tr(label));
      button.type = "submit";
      button.value = value;
      button.formNoValidate = !!cancel;
      return button;
    });
    $("fm-dialog-actions").replaceChildren(...buttons);
    dialog.returnValue = "";
    dialog.showModal();
    if (input !== undefined) { field.focus(); field.select(); }
    activeDialog = new Promise(resolve => dialog.addEventListener("close", () => {
      activeDialog = undefined;
      resolve({ action: dialog.returnValue, value: field.value.trim() });
    }, { once: true }));
    return activeDialog;
  }

  async function waitForDialog(signal) {
    while (activeDialog && !signal.aborted) {
      const pending = activeDialog;
      await new Promise(resolve => {
        signal.addEventListener("abort", resolve, { once: true });
        pending.then(() => {
          signal.removeEventListener("abort", resolve);
          resolve();
        });
      });
    }
  }

  const dismiss = { label: "取消", value: "", cancel: true };
  const save = { label: "保存", value: "save", className: "primary" };

  async function modifyRemote(action, params, workspace = state.remote.root) {
    try {
      await send("action", { body: { workspace, action, ...params } });
      if (workspace === state.remote.root) await list("remote", state.remote.parts, true);
    } catch (error) { toast(errorMessage(error.message), true); }
  }

  async function entryActions(entry) {
    const pane = state.remote;
    const workspace = pane.root;
    const path = fileAt(pane.parts, entry.name);
    const { action } = await ask({ title: "文件操作", text: entry.name, actions: [
      dismiss, { label: "重命名", value: "rename" }, { label: "移动", value: "move" },
      { label: "删除", value: "delete", className: "danger" },
    ] });
    if (action === "rename") {
      const result = await ask({ title: "重命名", input: entry.name, actions: [dismiss, save] });
      if (result.action) await modifyRemote(action, { path, name: result.value }, workspace);
    }
    if (action === "move") {
      const result = await ask({ title: "移动", text: tr("输入相对于工作空间根目录的路径。根目录用点表示。"), input: pathOf(pane.parts), actions: [dismiss, save] });
      if (result.action) await modifyRemote(action, { path, destination: result.value }, workspace);
    }
    if (action === "delete") {
      const result = await ask({ title: "删除此项目？", text: entry.name, actions: [
        dismiss, { label: "删除", value: "delete", className: "danger" },
      ] });
      if (result.action) await modifyRemote(action, { path }, workspace);
    }
  }

  async function preview(side, name) {
    previewRequest?.controller.abort();
    const controller = new AbortController();
    previewRequest = { side, controller };
    try {
      const res = await send(side, { query: { ...entryQuery(side, fileAt(state[side].parts, name)), preview: "1" }, signal: controller.signal });
      const image = await res.blob();
      if (controller.signal.aborted || !ready) return;
      if (previewURL) URL.revokeObjectURL(previewURL);
      previewURL = URL.createObjectURL(image);
      $("fm-preview-title").textContent = name;
      $("fm-preview-image").src = previewURL;
      $("fm-preview-image").alt = name;
      if (!$("fm-preview").open) $("fm-preview").showModal();
    } catch (error) {
      if (!controller.signal.aborted) toast(errorMessage(error.message), true);
    }
  }
  $("fm-preview").addEventListener("close", () => {
    previewRequest?.controller.abort();
    $("fm-preview-image").removeAttribute("src");
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = undefined;
  });

  function enqueue(side, names) {
    const { local, remote } = state;
    if (!local.root || !remote.root || local.loading || remote.loading || remote.loadingRoots || local.error || remote.error) return;
    const direction = side === "local" ? "upload" : "download";
    for (let i = 0; jobs.length + names.length > 400 && i < jobs.length;) {
      if (["running", "waiting"].includes(jobs[i].status)) i++;
      else jobs.splice(i, 1);
    }
    const waiting = jobs.filter(job => job.status === "waiting" || job.status === "running").length;
    if (names.length + waiting > 200) { toast(tr("一次最多传输 200 个文件"), true); return; }
    for (const name of names) {
      jobs.push({
        name, status: "waiting", bytes: 0, total: 0,
        req: {
          workspace: remote.root, folder: local.root, direction,
          source: fileAt(state[side].parts, name),
          destination: fileAt(state[otherSide(side)].parts, name),
        },
      });
    }
    renderQueue();
    void processQueue();
  }

  function renderQueue() {
    $("fm-transfers").classList.toggle("hidden", jobs.length === 0);
    $("fm-clear").disabled = jobs.every(job => job.status === "running" || job.status === "waiting");
    const list = $("fm-queue");
    const existing = new Map([...list.children].map(row => [row.job, row]));
    for (const job of jobs) {
      let row = existing.get(job);
      if (!row) {
        row = create("li", "fm-job");
        row.job = job;
        const badge = create("span", "fm-transfer-icon");
        badge.append(icon(job.req.direction));
        const meta = create("div");
        meta.append(create("strong", "fm-job-name", job.name), create("span", "fm-job-status"));
        const bar = create("progress");
        const button = create("button", "ghost");
        button.type = "button";
        button.addEventListener("click", () => {
          if (job.status === "running") job.controller?.abort();
          if (job.status === "waiting") job.status = "cancelled";
          if (job.status === "error") {
            job.status = "waiting";
            void processQueue();
          }
          renderQueue();
        });
        row.append(badge, meta, bar, button);
        list.append(row);
      }
      existing.delete(job);
      const [, meta, bar, button] = row.children;
      const status = meta.lastElementChild;
      status.dataset.state = job.status;
      const labels = { waiting: "等待传输", running: "正在传输", done: "传输完成", error: "文件操作失败", cancelled: "已取消", skipped: "已跳过" };
      const direction = tr(job.req.direction === "upload" ? "复制到服务器" : "保存到电脑");
      const message = job.error && job.status === "error" ? errorMessage(job.error) : tr(labels[job.status]);
      if (job.status === "done") bar.value = 1;
      else if (job.status === "running" && job.total > 0) bar.value = Math.min(1, job.bytes / job.total);
      else if (job.status === "running") bar.removeAttribute("value");
      else bar.value = 0;
      bar.setAttribute("aria-label", job.name);
      status.textContent = direction + " · " + message + (job.status === "running" && job.bytes ? " · " + formattedSize(job.bytes) : "");
      button.hidden = !["running", "waiting", "error"].includes(job.status);
      button.textContent = tr(job.status === "error" ? "重试" : "取消");
    }
    for (const row of existing.values()) row.remove();
  }

  async function transfer(job, request, signal) {
    job.bytes = 0;
    job.total = 0;
    const res = await send("transfer", { body: request, signal });
    const reader = res.body.getReader();
    try {
      return await readTransferEvents(job, reader);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function readTransferEvents(job, reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("传输中断");
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.done || event.error) return event;
        job.bytes = event.bytes;
        job.total = event.total;
        renderQueue();
      }
    }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      let job;
      while ((job = jobs.find(item => item.status === "waiting"))) {
        job.status = "running";
        const controller = new AbortController();
        job.controller = controller;
        renderQueue();
        try {
          let completion = await transfer(job, job.req, controller.signal);
          if (completion.conflict) {
            // Let the current file action finish before asking about this transfer.
            await waitForDialog(controller.signal);
            if (controller.signal.aborted) { job.status = "cancelled"; continue; }
            const { action } = await ask({ title: "目标已存在", text: job.name, actions: [
              { label: "跳过", value: "", cancel: true },
              { label: "保留两个文件", value: "keep" },
              { label: "替换", value: "replace", className: "danger" },
            ] });
            if (controller.signal.aborted) { job.status = "cancelled"; continue; }
            if (!action) { job.status = "skipped"; continue; }
            if (action === "replace") completion = await transfer(job, { ...job.req, replace: true }, controller.signal);
            else {
              const slash = job.req.destination.lastIndexOf("/");
              const dir = job.req.destination.slice(0, slash + 1);
              for (let n = 2; n <= 100 && completion.conflict; n++) {
                completion = await transfer(job, { ...job.req, destination: dir + availableCopyName(job.name, n) }, controller.signal);
              }
            }
          }
          job.status = completion.done ? "done" : "error";
          job.error = completion.error;
          const side = job.req.direction === "upload" ? "remote" : "local";
          const pane = state[side];
          const root = side === "local" ? job.req.folder : job.req.workspace;
          const parent = job.req.destination.split("/").slice(0, -1);
          if (completion.done && pane.root === root && pathOf(pane.parts) === pathOf(parent)) await list(side, pane.parts, true);
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : "error";
          job.error = error.message;
        } finally {
          job.controller = undefined;
          renderQueue();
        }
      }
    } finally { processing = false; }
  }

  function setAll(side) {
    const pane = state[side];
    const enabled = at(side, "all").checked;
    for (const entry of visibleEntries(side)) {
      if (entry.directory) continue;
      if (enabled) pane.selected.add(entry.name);
      else pane.selected.delete(entry.name);
    }
    renderRows(side);
  }

  for (const side of sides) {
    const pane = state[side];
    const panel = $("fm-" + side);
    at(side, "root").addEventListener("change", event => {
      pane.root = event.target.value;
      navigate(side, []);
    });
    at(side, "refresh").addEventListener("click", () => void (side === "remote" ? readRoots() : list(side, state.local.parts, true)));
    at(side, "back").addEventListener("click", () => navigate(side, pane.parts.slice(0, -1)));
    at(side, "filter").addEventListener("input", () => renderRows(side));
    at(side, "sort").addEventListener("click", () => { pane.descending = !pane.descending; renderRows(side); });
    at(side, "all").addEventListener("change", () => setAll(side));
    at(side, "copy").addEventListener("click", () => enqueue(side, [...pane.selected]));
    panel.addEventListener("dragover", event => {
      if (!dragged || dragged.side === side || !pane.root || pane.loading || pane.error) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      panel.classList.add("is-drop-target");
    });
    panel.addEventListener("dragleave", event => {
      if (!panel.contains(event.relatedTarget)) panel.classList.remove("is-drop-target");
    });
    panel.addEventListener("drop", event => {
      if (!dragged || dragged.side === side) return;
      event.preventDefault();
      enqueue(dragged.side, dragged.names);
      clearDrag();
    });
  }

  $("fm-clear").addEventListener("click", () => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (!["running", "waiting"].includes(jobs[i].status)) jobs.splice(i, 1);
    }
    renderQueue();
  });
  $("fm-mkdir").addEventListener("click", async () => {
    const workspace = state.remote.root;
    const path = pathOf(state.remote.parts);
    const result = await ask({ title: "新建文件夹", input: "", actions: [dismiss, save] });
    if (result.action) await modifyRemote("mkdir", { path, name: result.value }, workspace);
  });
  $("fm-pick-folder").addEventListener("click", async () => {
    if (pickerBusy) return;
    pickerBusy = true;
    $("fm-pick-folder").disabled = true;
    const currentAccount = accountKey;
    try {
      const picked = await (await send("pick-folder", { body: {} })).json();
      if (!picked.path || currentAccount !== accountKey) return;
      $("local-folder-name").value = picked.name;
      $("local-folder-path").value = picked.path;
      $("local-folder-form").requestSubmit();
    } catch (error) {
      if (currentAccount === accountKey) {
        pickManualFolder();
        toast(errorMessage(error.message), true);
      }
    } finally {
      pickerBusy = false;
      $("fm-pick-folder").disabled = false;
    }
  });

  function reset() {
    for (const side of sides) {
      const pane = state[side];
      pane.request?.abort();
      pane.rootsRequest?.abort();
      pane.roots = [];
      pane.root = "";
      pane.parts = [];
      pane.entries = [];
      pane.selected.clear();
      pane.loading = pane.loadingRoots = false;
      pane.error = "";
      at(side, "filter").value = "";
    }
    for (const job of jobs) job.controller?.abort();
    jobs.length = 0;
    clearDrag();
    if (dialog.open) dialog.close();
    if ($("fm-preview").open) $("fm-preview").close();
    previewRequest?.controller.abort();
    renderQueue();
  }

  return {
    update(next) {
      ready = !!next.paired;
      $("file-manager").classList.toggle("hidden", !ready);
      const identity = ready ? next.server + "\n" + next.user : "";
      const changed = identity !== accountKey;
      if (changed) {
        reset();
        accountKey = identity;
        folderKey = "";
      }
      if (!ready) return;
      const folders = next.folders || [];
      const key = JSON.stringify(folders);
      if (key !== folderKey) {
        folderKey = key;
        const local = state.local;
        local.roots = folders;
        const root = folders.some(folder => folder.id === local.root) ? local.root : folders[0]?.id || "";
        const changedRoot = root !== local.root;
        local.root = root;
        renderRoots("local");
        if (changedRoot || !root) navigate("local", []);
      }
      if (changed) {
        renderRoots("remote");
        void readRoots();
      }
    },
    translate() {
      for (const side of sides) {
        renderRoots(side);
        renderRows(side);
      }
      renderQueue();
    },
  };
}
