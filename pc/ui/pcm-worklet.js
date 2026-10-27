// Runs on the browser's audio thread: measures the PC microphone's level and, while recording, hands over its
// samples (mono, 32-bit float) in blocks of 0.1 s.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.startPending = false;
    this.stopPending = false;
    this.block = new Float32Array(Math.round(sampleRate / 10));
    this.fill = 0;
    this.peak = 0;
    this.sumSquares = 0;
    this.count = 0;
    this.port.onmessage = e => {
      if (e.data.cmd === 'start') this.startPending = true;
      if (e.data.cmd === 'stop') this.stopPending = true;
    };
  }

  flush() {
    if (this.fill === 0) return;
    const out = this.block.slice(0, this.fill);
    this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input[0] ? input[0].length : 128;
    if (this.startPending) {
      this.startPending = false;
      this.recording = true;
      this.fill = 0;
      this.port.postMessage({ type: 'started', frame: currentFrame });
    }
    for (let i = 0; i < frames; i++) {
      let v = 0;
      if (input && input.length) {
        for (let c = 0; c < input.length; c++) v += input[c][i];
        v /= input.length;
      }
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      this.sumSquares += v * v;
      this.count++;
      if (this.recording) {
        this.block[this.fill++] = v;
        if (this.fill === this.block.length) this.flush();
      }
    }
    if (this.count >= sampleRate / 20) {
      this.port.postMessage({ type: 'level', peak: this.peak, rms: Math.sqrt(this.sumSquares / this.count) });
      this.peak = 0;
      this.sumSquares = 0;
      this.count = 0;
    }
    if (this.stopPending) {
      this.stopPending = false;
      if (this.recording) {
        this.flush();
        this.recording = false;
      }
      this.port.postMessage({ type: 'stopped' });
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
