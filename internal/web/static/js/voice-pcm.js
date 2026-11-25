class PCMRecorder extends AudioWorkletProcessor {
    samples = new Int16Array(2048);
    count = 0;
    stopped = false;
    constructor() {
        super();
        this.port.onmessage = () => {
            this.stopped = true;
            this.flush();
            this.port.postMessage(null);
        };
    }
    flush() {
        if (!this.count)
            return;
        const chunk = this.samples.slice(0, this.count);
        this.port.postMessage(chunk, [chunk.buffer]);
        this.count = 0;
    }
    process(inputs) {
        if (this.stopped)
            return false;
        const channel = inputs[0]?.[0];
        if (!channel)
            return true;
        for (const sample of channel) {
            this.samples[this.count++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
            if (this.count === this.samples.length)
                this.flush();
        }
        return true;
    }
}
registerProcessor("agentbox-pcm", PCMRecorder);
export {};
