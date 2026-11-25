import { api } from "./api.js";
import { APIError } from "./problems.js";
const sampleRate = 16000;
const maxSamples = 30 * sampleRate;
const updateInterval = 2 * sampleRate;
export function canRecordVoice() {
    return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
        && !!window.AudioContext && !!window.AudioWorkletNode;
}
export async function serverVoiceEnabled(signal) {
    return (await api("/voice", { signal })).enabled;
}
export function recordServerVoice(options) {
    const controller = new AbortController();
    const audio = new AudioContext({ sampleRate });
    const samples = new Int16Array(maxSamples);
    let stream;
    let recorder;
    let count = 0;
    let requested = 0;
    let transcribed = 0;
    let stopping = false;
    let send = false;
    let reachedLimit = false;
    let pending;
    let flushTimer;
    let finalizing = false;
    let released = false;
    function release() {
        if (released)
            return;
        released = true;
        window.clearTimeout(flushTimer);
        recorder?.disconnect();
        recorder?.port.close();
        stream?.getTracks().forEach(track => track.stop());
        if (audio.state !== "closed")
            void audio.close().catch(() => { });
    }
    function cancel() {
        controller.abort();
        release();
    }
    function fail(error) {
        if (controller.signal.aborted)
            return;
        cancel();
        options.onError(error);
    }
    async function transcribe() {
        const snapshot = samples.slice(0, count);
        requested = count;
        const result = await api("/voice", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: snapshot.buffer,
            signal: controller.signal,
        });
        transcribed = snapshot.length;
        if (!controller.signal.aborted)
            options.onText(result.text);
    }
    async function finish() {
        if (finalizing || controller.signal.aborted)
            return;
        finalizing = true;
        release();
        try {
            await pending;
            if (controller.signal.aborted)
                return;
            if (count > transcribed)
                await transcribe();
            if (!controller.signal.aborted)
                options.onEnd(send, reachedLimit);
        }
        catch (error) {
            fail(error);
        }
    }
    function stop(shouldSend = true) {
        if (stopping || controller.signal.aborted)
            return;
        stopping = true;
        send = shouldSend;
        if (!recorder) {
            cancel();
            options.onEnd(false, false);
            return;
        }
        recorder.port.postMessage("flush");
        flushTimer = window.setTimeout(() => void finish(), 500);
    }
    async function start() {
        // Resume within the user gesture, before waiting on the server or permission.
        const resumed = audio.resume();
        void resumed.catch(fail);
        if (!await serverVoiceEnabled(controller.signal))
            throw new Error("whisper_disabled");
        if (controller.signal.aborted)
            return;
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
        if (controller.signal.aborted) {
            microphone.getTracks().forEach(track => track.stop());
            return;
        }
        stream = microphone;
        await resumed;
        await audio.audioWorklet.addModule(new URL("./voice-pcm.js", import.meta.url));
        if (controller.signal.aborted)
            return;
        recorder = new AudioWorkletNode(audio, "agentbox-pcm", { channelCount: 1, channelCountMode: "explicit" });
        recorder.onprocessorerror = fail;
        for (const track of stream.getAudioTracks()) {
            track.addEventListener("ended", () => stop(false), { once: true });
            if (track.readyState === "ended")
                throw new Error("microphone_disconnected");
        }
        recorder.port.onmessage = (event) => {
            if (finalizing || controller.signal.aborted)
                return;
            const chunk = event.data;
            if (chunk === null) {
                void finish();
                return;
            }
            const remaining = maxSamples - count;
            samples.set(chunk.subarray(0, remaining), count);
            count += Math.min(chunk.length, remaining);
            if (count === maxSamples && !stopping) {
                reachedLimit = true;
                stop(false);
            }
            else if (!stopping && !pending && count - requested >= updateInterval) {
                pending = transcribe().catch((error) => {
                    // The next snapshot still includes the audio skipped by a busy worker.
                    if (!(error instanceof APIError && error.status === 429))
                        fail(error);
                }).finally(() => { pending = undefined; });
            }
        };
        audio.createMediaStreamSource(stream).connect(recorder).connect(audio.destination);
        options.onReady();
    }
    void start().catch(fail);
    return { stop, cancel };
}
