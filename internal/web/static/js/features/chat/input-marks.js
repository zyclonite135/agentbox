/* 输入框里的 /命令、@路径 显示成蓝字。textarea 不能给部分文字上色，所以在它身后
 * 铺一层同字体、同内边距、同换行规则的镜像：有标记时 textarea 的字设为透明（光标、
 * 选区照旧），看到的字由镜像画出；没有标记时镜像清空、textarea 照常显示，
 * 平时的输入一点不受影响。镜像只读 value，跟随 textarea 的滚动与滚动条宽度。
 *
 * 写完的 @路径 是一个整体：删除键碰到它就整块删掉。做法是在按键默认动作之前
 * 把选区扩成整块，删除仍由浏览器完成，撤销栈与 input 事件都是原生的。正在敲的 @路径
 * （光标停在它里面、上一次改动就在它身上）照常逐字删，否则打错一个字就得整段重来。 */
export function createInputMarks(hooks) {
    let shown = "";
    let typing = -1; // 正在敲的 @路径 的起点
    function sync() {
        const input = hooks.input(), layer = hooks.layer();
        // textarea 出现滚动条时内容变窄，镜像要让出同样的宽度才会在同一处换行
        layer.style.setProperty("--marks-gutter", input.offsetWidth - input.clientWidth + "px");
        layer.scrollTop = input.scrollTop;
    }
    function render() {
        const input = hooks.input(), layer = hooks.layer(), text = input.value;
        const marks = text ? hooks.marks(text) : [];
        input.classList.toggle("marked", marks.length > 0);
        const key = marks.length ? text + "\0" + marks.map(m => m.kind + m.start + "-" + m.end).join() : "";
        if (key !== shown) {
            shown = key;
            const parts = [];
            let at = 0;
            for (const m of marks) {
                if (m.start > at)
                    parts.push(text.slice(at, m.start));
                const span = document.createElement("span");
                span.className = "mark-" + m.kind;
                span.textContent = text.slice(m.start, m.end);
                parts.push(span);
                at = m.end;
            }
            if (marks.length && at < text.length)
                parts.push(text.slice(at));
            // textarea 末尾的换行会多出一个空行，div 不会；补一个零宽字符撑出这一行
            if (marks.length && text.endsWith("\n"))
                parts.push("​");
            layer.replaceChildren(...parts);
        }
        if (marks.length)
            sync();
    }
    /** 光标所在的 @路径（光标在它里面或紧贴末尾） */
    const mentionAt = (marks, caret) => marks.find(m => m.kind === "mention" && m.start < caret && caret <= m.end);
    /** 删除键要整块删掉的标记：光标贴着它（退格在末尾、Delete 在开头） */
    function wholeAt(marks, caret, back) {
        // 光标离开了正在敲的那个 @路径（填入后补了空格、点到别处），它就算写完了
        if (mentionAt(marks, caret)?.start !== typing)
            typing = -1;
        return marks.find(m => m.kind === "mention" && m.start !== typing && caret === (back ? m.end : m.start));
    }
    /** 把选区扩成这次要删的范围；光标处没有整块要删时返回 null */
    function grab(back) {
        const input = hooks.input();
        const from = input.selectionStart ?? 0, to = input.selectionEnd ?? from;
        if (from !== to)
            return null;
        const mark = wholeAt(hooks.marks(input.value), from, back);
        if (!mark)
            return null;
        input.setSelectionRange(mark.start, mark.end, back ? "backward" : "forward");
        return [mark.start, mark.end];
    }
    return {
        render,
        /** textarea 滚动时跟着滚 */
        scrolled() { if (shown)
            sync(); },
        /** 退格 / Delete：在浏览器默认删除之前把选区扩成整块 */
        keydown(e) {
            if ((e.key !== "Backspace" && e.key !== "Delete") || e.isComposing || e.keyCode === 229)
                return;
            grab(e.key === "Backspace");
        },
        /** 软键盘不一定发按键事件（Android 只有 beforeinput），这里再兜一次 */
        beforeinput(e) {
            if (e.isComposing || !e.cancelable || (e.inputType !== "deleteContentBackward" && e.inputType !== "deleteContentForward"))
                return;
            const input = hooks.input();
            if (input.selectionStart !== input.selectionEnd)
                return;
            const range = grab(e.inputType === "deleteContentBackward");
            if (!range)
                return;
            e.preventDefault();
            input.setRangeText("", range[0], range[1], "end");
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: e.inputType }));
        },
        /** 每次 input：认出正在敲的 @路径 */
        edited(e) {
            const input = hooks.input(), text = input.value, caret = input.selectionStart ?? text.length;
            const kind = e instanceof InputEvent ? e.inputType : "";
            const m = kind ? mentionAt(hooks.marks(text), caret) : undefined;
            // 敲进去的字落在 @路径 上，或在它中间删字，就是在改它；接着删也还是在改
            typing = m && (kind.startsWith("insert") || caret < m.end || m.start === typing) ? m.start : -1;
        },
    };
}
