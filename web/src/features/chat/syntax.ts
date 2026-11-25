/* 消息里有特殊含义的写法：开头的 /命令，和 @路径（Claude Code 会把文件内容带进这一轮）。
 * 输入框（input-marks.ts）把它们标成蓝字，发出去的消息气泡（chat-render.ts）另换样式。
 * 规则与 CLI 一致：命令名同 agent.IsClaudeSlashCommand；@ 必须在开头或空白之后（邮箱不算），
 * 含空白的路径写成 @"…"。Codex 不解释两者，只有网页自己接管的命令算数。 */

export type SyntaxMark = { start: number; end: number; kind: "command" | "mention" };

const COMMAND_RE = /^\s*(\/[a-zA-Z0-9_][a-zA-Z0-9:_-]*)(?=\s|$)/;
const MENTION_RE = /(^|\s)(@(?:"[^"\n]*"?|[^\s"]+))/g;

/** webCommand：网页接管的命令（在 Codex 空间里也算命令） */
export function syntaxMarks(text: string, agent: string, webCommand: (name: string) => boolean = () => false): SyntaxMark[] {
  const marks: SyntaxMark[] = [];
  const command = COMMAND_RE.exec(text);
  if (command && (agent === "claude" || webCommand(command[1].slice(1)))) {
    const start = command[0].length - command[1].length;
    marks.push({ start, end: command[0].length, kind: "command" });
  }
  if (agent === "claude") for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index + m[1].length;
    marks.push({ start, end: start + m[2].length, kind: "mention" });
  }
  return marks.sort((a, b) => a.start - b.start);
}
