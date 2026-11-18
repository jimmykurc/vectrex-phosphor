/**
 * Web Audio output for the AY-3-8912. The PSG renders samples while the
 * machine runs; they are posted to an AudioWorklet once per animation frame.
 */
export class AudioOut {
  constructor(psg) {
    this.psg = psg;
    this.ctx = null;
    this.node = null;
    this.enabled = false;
    this.volume = 0.8;
  }

  get supported() { return typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined'; }

  async enable() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(new URL('./psg-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'psg-player', { outputChannelCount: [2] });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.psg.setSampleRate(this.ctx.sampleRate);
    }
    await this.ctx.resume();
    this.psg.drain();
    this.node.port.postMessage('flush');
    this.psg.enabled = true;
    this.enabled = true;
  }

  async disable() {
    this.enabled = false;
    this.psg.enabled = false;
    if (this.ctx) await this.ctx.suspend();
  }

  /** Forward the samples generated since the last call. */
  push() {
    const samples = this.psg.drain();
    if (this.enabled && this.node && samples.length) this.node.port.postMessage(samples, [samples.buffer]);
  }
}
