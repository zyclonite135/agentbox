/** An unfinished fence extends to the end so partial answers can render it while streaming. */
export function* markdownFences(text) {
    const lines = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
    let open;
    for (const match of text.matchAll(lines)) {
        const [, delimiter, suffix] = match;
        const info = suffix.trim();
        const start = match.index;
        const end = start + match[0].length;
        if (open) {
            if (delimiter[0] !== open.delimiter[0] || delimiter.length < open.delimiter.length || info)
                continue;
            yield { ...open, bodyEnd: start, end, closed: true };
            open = undefined;
        }
        else if (delimiter[0] !== "\x60" || !info.includes("\x60")) {
            open = { delimiter, info, start, bodyStart: end };
        }
    }
    if (open)
        yield { ...open, bodyEnd: text.length, end: text.length, closed: false };
}
