import { fileDownloadURL } from "../../api.js";
import { t, setAttrRender, setText, setTextRender } from "../../i18n.js";
import { svgIcon } from "../../icons.js";
import { S } from "../../state.js";
import { fmtBytes } from "../../util.js";
const internalNames = new Set([".git", ".agentbox", ".codex", ".claude", ".ds_store", "thumbs.db"]);
const fences = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)\r?$/gm;
export function splitResultFiles(message, streaming = false) {
    let open = "", start, end;
    for (const fence of message.matchAll(fences)) {
        const [, delimiter, suffix] = fence;
        if (open) {
            if (delimiter[0] !== open[0] || delimiter.length < open.length || suffix.trim())
                continue;
            if (start && !message.slice(fence.index + fence[0].length).trim()) {
                end = fence;
                break;
            }
            open = "";
            start = undefined;
            continue;
        }
        open = delimiter;
        if (delimiter === "\x60\x60\x60" && suffix.trim() === "agentbox-files")
            start = fence;
    }
    if (!start)
        return { text: message };
    const text = message.slice(0, start.index).trimEnd();
    if (!end)
        return { text: streaming ? text : message };
    const raw = message.slice(start.index + start[0].length, end.index).trim();
    if (raw.length > 768 * 1024)
        return { text: message };
    let result;
    try {
        result = JSON.parse(raw);
    }
    catch {
        return { text: message };
    }
    if (!result || !Array.isArray(result.files) || result.files.length > 512)
        return { text: message };
    const files = new Map();
    for (const file of result.files) {
        const path = file?.path;
        if (typeof path !== "string" || new TextEncoder().encode(path).length > 1024 ||
            /[\\:\x00\r\n]/.test(path) || path.split("/").some(part => !part || part === "." ||
            part === ".." || internalNames.has(part.toLowerCase())))
            continue;
        if (files.has(path))
            continue;
        const bytes = Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? file.bytes : undefined;
        files.set(path, { path, bytes });
    }
    if (!files.size)
        return { text: message };
    const title = typeof result.title === "string" ? result.title.trim().slice(0, 100) : "";
    return { text, result: { title, files: [...files.values()] } };
}
function element(tag, cls, text) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function fileIcon(ext) {
    if (/^(png|jpe?g|gif|webp|svg|avif)$/.test(ext))
        return "file.image";
    if (/^(zip|tar|gz|7z|rar)$/.test(ext))
        return "file.archive";
    if (/^(html?|css|[jt]sx?|json|xml|py|go)$/.test(ext))
        return "file.code";
    if (ext === "pdf")
        return "chat.result-pdf";
    if (/^(csv|xlsx?|ods)$/.test(ext))
        return "chat.result-sheet";
    if (/^(docx?|odt|txt|rtf|md)$/.test(ext))
        return "chat.result-document";
    return "file.generic";
}
function downloadAction(url, name, archive) {
    const session = S.current?.id, token = S.token;
    const action = element("div", "chat-result-action");
    const btn = element("button", archive ? "btn chat-result-download chat-result-zip" : "btn btn-sm chat-result-download");
    btn.type = "button";
    const label = element("span", "");
    const actionLabel = archive ? "下载 ZIP" : "下载文件";
    setText(label, actionLabel);
    setAttrRender(btn, "aria-label", () => t(actionLabel) + " " + name);
    btn.append(svgIcon("download", 16), label);
    const status = element("span", "chat-result-status");
    status.setAttribute("role", "status");
    action.append(btn, status);
    btn.addEventListener("click", async () => {
        if (btn.disabled || session !== S.current?.id || token !== S.token)
            return;
        btn.disabled = true;
        status.classList.remove("error");
        setText(status, "正在准备下载…");
        const active = () => btn.isConnected && session === S.current?.id && token === S.token;
        const showError = (message) => {
            status.classList.add("error");
            setText(status, message);
        };
        try {
            const response = await fetch(url, archive ? {
                method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
                body: JSON.stringify({ paths: archive }),
            } : { cache: "no-store" });
            if (!active()) {
                await response.body?.cancel();
                return;
            }
            if (!response.ok) {
                if (response.status === 404)
                    showError(archive ? "部分文件已不可用，无法下载 ZIP。" : "文件已移动或删除。");
                else if (response.status === 413 && archive)
                    showError("文件总大小超过 ZIP 限制。");
                else
                    showError(archive ? "无法创建 ZIP，请重试。" : "下载失败，请重试。");
                return;
            }
            const blob = await response.blob();
            if (!active())
                return;
            const objectURL = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectURL;
            link.download = name;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectURL), 60_000);
            setText(status, "已开始下载");
        }
        catch {
            if (active())
                showError("下载失败，请重试。");
        }
        finally {
            btn.disabled = false;
        }
    });
    return action;
}
function row(file) {
    const name = file.path.split("/").at(-1);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const wrap = element("div", "chat-result-file");
    const icon = element("span", "chat-result-icon");
    icon.append(svgIcon(fileIcon(ext), 21));
    const info = element("div", "chat-result-file-info");
    const label = element("strong", "chat-result-name", name);
    label.title = file.path;
    const meta = element("div", "chat-result-meta");
    setTextRender(meta, () => [ext.toUpperCase() || t("文件"), file.bytes === undefined ? "" : fmtBytes(file.bytes)]
        .filter(Boolean).join(" · "));
    info.append(label, meta);
    wrap.append(icon, info, downloadAction(fileDownloadURL(file.path, "workspace"), name));
    return wrap;
}
export function resultFilesCard(result) {
    if (!S.current)
        return null;
    const card = element("section", "chat-results");
    if (result.files.length <= 4) {
        card.append(...result.files.map(row));
        return card;
    }
    card.classList.add("chat-results-project");
    const header = element("header", "chat-result-project-head");
    const icon = element("span", "chat-result-icon");
    icon.append(svgIcon("file.archive", 23));
    const title = element("strong", "chat-result-name");
    if (result.title)
        title.textContent = title.title = result.title;
    else
        setText(title, "项目文件");
    const count = element("span", "chat-result-meta");
    setText(count, "{p0} 个结果文件", { p0: result.files.length });
    const heading = element("div", "chat-result-file-info");
    heading.append(title, count);
    header.append(icon, heading);
    const name = (result.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/, "") || "project") + ".zip";
    const archive = downloadAction(`/api/sessions/${encodeURIComponent(S.current.id)}/chat/files/archive`, name, result.files.map(file => file.path));
    const details = element("details", "chat-result-list");
    const summary = element("summary", "");
    const summaryLabel = element("span", "");
    setText(summaryLabel, "文件列表");
    summary.append(summaryLabel, svgIcon("chevron", 16));
    const contents = element("div", "chat-result-contents");
    const folders = new Map();
    for (const file of result.files) {
        const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        let group = folders.get(directory);
        if (!group) {
            group = element("div", "chat-result-folder");
            if (directory) {
                const label = element("div", "chat-result-directory");
                label.append(svgIcon("file.folder", 15), element("span", "", directory));
                group.append(label);
            }
            folders.set(directory, group);
            contents.append(group);
        }
        group.append(row(file));
    }
    details.append(summary, contents);
    card.append(header, archive, details);
    return card;
}
