/**
 * AudioWorklet that plays PSG samples pushed from the main thread through a
 * ring buffer. A small pre-buffer absorbs the bursty delivery (one batch per
 * animation frame); excess latency is trimmed if the producer runs ahead.
 */
class PsgPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 16384;
    this.buf = new Float32Array(this.size);
    this.r = 0; this.w = 0; this.n = 0;
    this.primed = false;
    this.last = 0;
    this.target = Math.round(sampleRate * 0.05); // ~50 ms
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.n = 0; this.r = this.w; this.primed = false; return; }
      const s = e.data;
      for (let i = 0; i < s.length; i++) {
        if (this.n === this.size) { this.r = (this.r + 1) % this.size; this.n--; }
        this.buf[this.w] = s[i];
        this.w = (this.w + 1) % this.size;
        this.n++;
      }
      if (this.n > this.target * 3) { // too far behind real time: drop the oldest audio
        const drop = this.n - this.target;
        this.r = (this.r + drop) % this.size;
        this.n -= drop;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    if (!this.primed && this.n >= this.target) this.primed = true;
    for (let i = 0; i < left.length; i++) {
      if (this.primed && this.n > 0) {
        this.last = this.buf[this.r];
        this.r = (this.r + 1) % this.size;
        this.n--;
      } else {
        this.primed = false;
        this.last *= 0.995; // fade instead of clicking on underrun
      }
      left[i] = this.last;
    }
    for (let c = 1; c < out.length; c++) out[c].set(left);
    return true;
  }
}

registerProcessor('psg-player', PsgPlayer);
