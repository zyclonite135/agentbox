declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof PCMRecorder): void;

class PCMRecorder extends AudioWorkletProcessor {
  private samples = new Int16Array(2048);
  private count = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.stopped = true;
      this.flush();
      this.port.postMessage(null);
    };
  }

  private flush() {
    if (!this.count) return;
    const chunk = this.samples.slice(0, this.count);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.count = 0;
  }

  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.samples[this.count++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
      if (this.count === this.samples.length) this.flush();
    }
    return true;
  }
}

registerProcessor("agentbox-pcm", PCMRecorder);

export {};
