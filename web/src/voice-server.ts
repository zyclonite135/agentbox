import { api } from "./api.js";

const sampleRate = 16000;
const maxSamples = 30 * sampleRate;
const updateInterval = 2 * sampleRate;

export function canRecordVoice() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
    && !!window.AudioContext && !!window.AudioWorkletNode;
}

export async function serverVoiceEnabled(signal?: AbortSignal) {
  return (await api<{ enabled: boolean }>("/voice", { signal })).enabled;
}

export function recordServerVoice(options: {
  onReady: () => void;
  onText: (text: string) => void;
  onEnd: (send: boolean, reachedLimit: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const controller = new AbortController();
  const audio = new AudioContext({ sampleRate });
  const samples = new Int16Array(maxSamples);
  let stream: MediaStream | undefined;
  let recorder: AudioWorkletNode | undefined;
  let count = 0;
  let requested = 0;
  let stopping = false;
  let send = false;
  let reachedLimit = false;
  let pending: Promise<void> | undefined;
  let flushTimer: number | undefined;
  let finalizing = false;

  function release() {
    window.clearTimeout(flushTimer);
    recorder?.disconnect();
    recorder?.port.close();
    stream?.getTracks().forEach(track => track.stop());
    if (audio.state !== "closed") void audio.close().catch(() => {});
  }

  function cancel() {
    controller.abort();
    release();
  }

  function fail(error: unknown) {
    if (controller.signal.aborted) return;
    cancel();
    options.onError(error);
  }

  async function transcribe() {
    const snapshot = samples.slice(0, count);
    requested = count;
    const result = await api<{ text: string }>("/voice", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: snapshot.buffer,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) options.onText(result.text);
  }

  async function finish() {
    if (finalizing || controller.signal.aborted) return;
    finalizing = true;
    release();
    try {
      await pending;
      if (controller.signal.aborted) return;
      if (count > requested) await transcribe();
      if (!controller.signal.aborted) options.onEnd(send, reachedLimit);
    } catch (error) {
      fail(error);
    }
  }

  function stop(shouldSend = true) {
    if (stopping || controller.signal.aborted) return;
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
    if (!await serverVoiceEnabled(controller.signal)) throw new Error("whisper_disabled");
    if (controller.signal.aborted) return;
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    if (controller.signal.aborted) {
      microphone.getTracks().forEach(track => track.stop());
      return;
    }
    stream = microphone;
    await resumed;
    await audio.audioWorklet.addModule(new URL("./voice-pcm.js", import.meta.url));
    if (controller.signal.aborted) return;
    recorder = new AudioWorkletNode(audio, "agentbox-pcm", { channelCount: 1, channelCountMode: "explicit" });
    recorder.onprocessorerror = fail;
    recorder.port.onmessage = (event: MessageEvent<Int16Array | null>) => {
      if (finalizing || controller.signal.aborted) return;
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
      } else if (!stopping && !pending && count - requested >= updateInterval) {
        pending = transcribe().catch(fail).finally(() => { pending = undefined; });
      }
    };
    audio.createMediaStreamSource(stream).connect(recorder).connect(audio.destination);
    options.onReady();
  }

  void start().catch(fail);
  return { stop, cancel };
}
