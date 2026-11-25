import type { Draft, DraftAttachment } from "./draft-store.js";

// Transcript markers keep the agent's file reference and optionally the original filename.
export const attachmentMarker = /\[(图片|附件)#(\d+) (\/shared\/\.(?:images|file)\/[A-Za-z0-9][A-Za-z0-9._-]{0,255})(?: name=([^\s\[\]]+))?\]/g;

export function attachmentName(path: string, encoded?: string) {
  if (encoded) {
    try {
      const name = decodeURIComponent(encoded).split(/[/\\]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "");
      if (name) return name;
    } catch { /* Older messages can omit the name; malformed names also fall back. */ }
  }
  return path.split("/").pop() || "";
}

function removeMarkers(text: string, marker: RegExp) {
  let changed = false;
  const lines = text.split("\n").flatMap(line => {
    const clean = line.replace(marker, "");
    if (clean === line) return [line];
    changed = true;
    return clean.trim() ? [clean.trimEnd()] : [];
  });
  return changed ? lines.join("\n").trim() : text;
}

export function cleanDraftText({ text, attachments, separateAttachments }: Draft) {
  if (separateAttachments || !attachments.length) return text;
  const tokens = attachments.map(({ id, kind }) => `${kind === "img" ? "Image" : "File"} #${id}`);
  return removeMarkers(text, new RegExp(`\\[(?:${tokens.join("|")})\\] ?`, "g"));
}

export function attachmentPrompt(text: string, attachments: DraftAttachment[]) {
  const refs = attachments.filter(a => a.path).map(({ id, kind, path, orig }) => {
    const name = orig && orig !== attachmentName(path) ? ` name=${encodeURIComponent(orig.replace(/[\uD800-\uDFFF]/gu, "\uFFFD"))}` : "";
    return `[${kind === "img" ? "图片" : "附件"}#${id} ${path}${name}]`;
  });
  return [text.trim(), refs.join("\n")].filter(Boolean).join("\n\n");
}

export function splitAttachmentPrompt(text: string): Draft {
  const attachments: DraftAttachment[] = [];
  const paths = new Set<string>();
  const ids = new Set<number>();
  let next = 1;
  for (const [, type, rawId, path, orig] of text.matchAll(attachmentMarker)) {
    if (paths.has(path)) continue;
    let id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || id > 1_000_000 || ids.has(id)) {
      while (ids.has(next)) ++next;
      id = next++;
    }
    paths.add(path);
    ids.add(id);
    attachments.push({ id, path, name: attachmentName(path), orig: attachmentName(path, orig), kind: type === "图片" ? "img" : "file", valid: false });
  }
  const withSpacing = new RegExp(attachmentMarker.source + " ?", "g");
  return { text: removeMarkers(text, withSpacing), attachments, separateAttachments: true };
}
