import { i18n, setAttrRender, t as i18nText } from "./i18n.js";
/* voice：语音输入。用浏览器内置的 Web Speech API 识别（Chrome/Edge/Safari；
 * Firefox 不支持则隐藏入口）。点击开始录音，边说边把文字实时写进输入框，
 * 再点一次停止，识别文字留在输入框里。 */
"use strict";
import { S, bus } from "./state.js";
import { $, toast, isImeEnter, enterInsertsNewline } from "./util.js";
import { autoGrow } from "./chat.js";
import { setTip } from "./tip.js";
import { canRecordVoice, recordServerVoice, serverVoiceEnabled } from "./voice-server.js";
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const btn = $("btn-voice");
const input = $("chat-input");
const serverPreference = "agentbox-voice-server";
const serverSupported = canRecordVoice();
let useServer = false;
try {
    useServer = localStorage.getItem(serverPreference) === "true";
}
catch (_) { }
let serverRec;
let voiceAttempt = 0;
function preferServer(enabled) {
    useServer = enabled;
    try {
        localStorage.setItem(serverPreference, String(enabled));
    }
    catch (_) { }
}
function idleTitle() {
    if (!SR || useServer) {
        return SR
            ? i18nText("服务器语音输入（Shift+点击切回浏览器识别）")
            : i18nText("服务器语音输入");
    }
    return serverSupported
        ? i18nText("语音输入：点击说话，再点一次停止（Shift+点击使用服务器识别）")
        : i18nText("语音输入：点击说话，再点一次停止");
}
let rec = null; // 当前识别实例，非 null 即录音中
let base = ""; // 录音开始时输入框已有的内容
let finalText = ""; // 已定稿的识别结果（interim 部分每次整体重写）
let stopRequested = false;
if (!SR && !serverSupported)
    btn.classList.add("hidden");
setRecUI(false);
btn.addEventListener("click", (event) => {
    if (serverRec) {
        serverRec.stop();
        return;
    }
    if (rec) {
        stopNativeRecording();
        return;
    }
    voiceAttempt++;
    if (event.shiftKey && SR && serverSupported)
        preferServer(!useServer);
    if (serverSupported && (!SR || useServer))
        startServer();
    else if (SR)
        start();
});
function startServer() {
    const original = input.value;
    const prefix = original && !/\s$/.test(original) ? original + " " : original;
    const thread = S.thread;
    const session = S.current;
    try {
        serverRec = recordServerVoice({
            onReady: () => toast(i18nText("正在聆听，再点一次 🎤 停止")),
            onText: (text) => {
                if (S.thread?.id !== thread?.id || S.current?.id !== session?.id) {
                    abortServerRecording();
                    return;
                }
                const transcript = text.trim();
                input.value = transcript ? prefix + transcript : original;
                autoGrow();
            },
            onEnd: (reachedLimit) => {
                serverRec = undefined;
                setRecUI(false);
                if (reachedLimit)
                    toast(i18nText("单次服务器语音输入限时 30 秒，文字已保留"));
            },
            onError: (error) => {
                serverRec = undefined;
                if (error instanceof Error && error.message === "whisper_disabled") {
                    if (SR)
                        preferServer(false);
                    toast(i18nText("服务器语音识别未启用"), true);
                }
                else if (error instanceof DOMException && error.name === "NotAllowedError") {
                    toast(i18nText("麦克风权限被拒绝，请在浏览器允许（非 localhost 访问需 HTTPS）"), true);
                }
                else {
                    toast(i18nText("服务器语音识别失败，请重试"), true);
                }
                setRecUI(false);
            },
        });
        setRecUI(true);
    }
    catch (_) {
        setRecUI(false);
        toast(i18nText("服务器语音识别失败，请重试"), true);
    }
}
function offerServerVoice() {
    if (!serverSupported)
        return;
    const attempt = voiceAttempt;
    void serverVoiceEnabled().then((enabled) => {
        if (!enabled || attempt !== voiceAttempt || rec || serverRec)
            return;
        preferServer(true);
        setRecUI(false);
        toast(i18nText("浏览器语音识别不可用。再次点击麦克风即可使用服务器识别，请重新说一遍。"));
    }).catch(() => { });
}
function start() {
    const r = new SR();
    // New recognition sessions use the selected interface language.
    r.lang = i18n.locale;
    r.continuous = true;
    r.interimResults = true;
    base = input.value && !/\s$/.test(input.value) ? input.value + " " : input.value;
    finalText = "";
    stopRequested = false;
    let fallback = false;
    let failed = false; // 出错后 onend 不再自动续听
    r.onresult = (e) => {
        if (rec !== r)
            return;
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal)
                finalText += res[0].transcript;
            else
                interim += res[0].transcript;
        }
        input.value = base + finalText + interim;
        autoGrow();
    };
    r.onerror = (e) => {
        if (rec !== r)
            return;
        if (e.error === "no-speech" || e.error === "aborted")
            return;
        failed = true;
        fallback = e.error === "network" || e.error === "service-not-allowed" || e.error === "language-not-supported";
        const msg = {
            "not-allowed": i18nText("麦克风权限被拒绝，请在浏览器允许（非 localhost 访问需 HTTPS）"),
            "service-not-allowed": i18nText("浏览器禁用了语音识别服务（非 localhost 访问需 HTTPS）"),
            "audio-capture": i18nText("未检测到可用的麦克风"),
            network: i18nText("语音识别网络异常（识别由浏览器云端服务完成）"),
        }[e.error] || i18nText("语音识别出错：") + e.error;
        toast(msg, true);
    };
    r.onend = () => {
        if (rec !== r)
            return; // 已被手动发送等路径掐掉
        // 静音等原因自动结束：用户没点停就悄悄续上
        if (!stopRequested && !failed) {
            try {
                r.start();
                return;
            }
            catch (_) {
                fallback = true;
            }
        }
        rec = null;
        setRecUI(false);
        if (fallback)
            offerServerVoice();
    };
    try {
        r.start();
    }
    catch (e) {
        toast(i18nText("无法启动语音识别：") + e.message, true);
        offerServerVoice();
        return;
    }
    rec = r;
    setRecUI(true);
    toast(i18nText("正在聆听，再点一次 🎤 停止"));
}
function stopNativeRecording() {
    stopRequested = true;
    try {
        rec.stop();
    }
    catch (_) { }
}
function setRecUI(on) {
    btn.classList.toggle("rec", on);
    setTip(btn, () => on ? i18nText("停止录音") : idleTitle());
    setAttrRender(btn, "aria-label", () => on ? i18nText("停止录音") : i18nText("语音输入")); // 纯图标按钮，可访问名称得跟着状态走
}
/* 录音途中手动发送（Enter / 发送键）：先掐掉识别，
 * 免得迟到的识别结果把已发送的旧文字又写回输入框 */
function abortServerRecording() {
    if (!serverRec)
        return;
    serverRec.cancel();
    serverRec = undefined;
    setRecUI(false);
}
for (const event of ["thread-changed", "open-session", "view-changed", "unauthorized"]) {
    bus.addEventListener(event, abortIfRecording);
}
input.addEventListener("input", abortServerRecording);
function abortIfRecording() {
    voiceAttempt++;
    abortServerRecording();
    if (!rec)
        return;
    const r = rec;
    rec = null;
    setRecUI(false);
    try {
        r.abort();
    }
    catch (_) { }
}
$("chat-send").addEventListener("click", abortIfRecording, true);
input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e) && !enterInsertsNewline())
        abortIfRecording();
}, true);
window.addEventListener("agentbox-language-change", () => setRecUI(!!rec || !!serverRec));
