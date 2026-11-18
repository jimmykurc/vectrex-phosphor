/**
 * General Instrument AY-3-8912 programmable sound generator.
 *
 * Three square-wave tone channels, a 17-bit LFSR noise generator, the
 * 16-shape envelope generator, logarithmic DAC levels and the I/O port
 * (register 14) that the Vectrex wires to the controller buttons.
 *
 * The chip is clocked from the 1.5 MHz system clock. Internally it advances
 * in steps of 8 clocks (187.5 kHz) and is box-filtered down to the audio
 * sample rate. Register writes are timestamped with the CPU cycle counter so
 * that sound stays in sync with the program.
 */

// Measured AY-3-8910 output levels, normalised to 1.0
const LEVELS = [
  0.0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0,
];

const REG_MASK = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff];

export class AY38912 {
  constructor({ clock = 1500000, sampleRate = 48000 } = {}) {
    this.clock = clock;
    this.tickRate = clock / 8;
    this.regs = new Uint8Array(16);
    /** Returns the byte present on I/O port A (active-low buttons on a Vectrex). */
    this.portAInput = () => 0xff;
    this.enabled = false;
    this.setSampleRate(sampleRate);
    this.reset(0);
  }

  setSampleRate(rate) {
    this.sampleRate = rate;
    this.step = rate / this.tickRate; // output samples per internal tick
    this.out = new Float32Array(Math.ceil(rate / 10)); // up to 100 ms per drain
    this.outLen = 0;
  }

  reset(cycle = 0) {
    this.regs.fill(0);
    this.toneCnt = [0, 0, 0];
    this.toneOut = [0, 0, 0];
    this.noiseCnt = 0;
    this.lfsr = 1;
    this.noiseOut = 0;
    this.envCnt = 0;
    this.envStep = 0x0f;
    this.envAttack = 0;
    this.envHold = false;
    this.envAlt = false;
    this.envHolding = false;
    this.envVol = 0;
    this.lastCycle = cycle;
    this.cycleFrac = 0;
    this.phase = 0;
    this.acc = 0;
    this.accN = 0;
    this.dac = 0; // external Vectrex DAC sound path (mux channel 3)
    this.dcPrev = 0; this.dcOut = 0;
  }

  read(reg) {
    reg &= 0x0f;
    if (reg === 14) return this.regs[7] & 0x40 ? this.regs[14] : this.portAInput() & 0xff;
    return this.regs[reg];
  }

  /** Write a register at the given CPU cycle (sound is generated up to that point first). */
  write(reg, value, cycle) {
    reg &= 0x0f;
    if (cycle !== undefined) this.advanceTo(cycle);
    this.regs[reg] = value & REG_MASK[reg];
    if (reg === 13) this.restartEnvelope();
  }

  setDac(value, cycle) {
    if (cycle !== undefined) this.advanceTo(cycle);
    this.dac = value;
  }

  restartEnvelope() {
    const shape = this.regs[13];
    this.envAttack = shape & 0x04 ? 0x0f : 0x00;
    if (!(shape & 0x08)) { this.envHold = true; this.envAlt = !!this.envAttack; }
    else { this.envHold = !!(shape & 0x01); this.envAlt = !!(shape & 0x02); }
    this.envStep = 0x0f;
    this.envHolding = false;
    this.envCnt = 0;
    this.envVol = this.envStep ^ this.envAttack;
  }

  tick() {
    const r = this.regs;
    for (let ch = 0; ch < 3; ch++) {
      const period = (r[ch * 2] | (r[ch * 2 + 1] << 8)) || 1;
      if (++this.toneCnt[ch] >= period) { this.toneCnt[ch] = 0; this.toneOut[ch] ^= 1; }
    }
    const nPeriod = (r[6] || 1) * 2;
    if (++this.noiseCnt >= nPeriod) {
      this.noiseCnt = 0;
      const bit = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 16);
      this.noiseOut = this.lfsr & 1;
    }
    const ePeriod = ((r[11] | (r[12] << 8)) || 1) * 2;
    if (++this.envCnt >= ePeriod) {
      this.envCnt = 0;
      if (!this.envHolding) {
        this.envStep--;
        if (this.envStep < 0) {
          if (this.envHold) {
            if (this.envAlt) this.envAttack ^= 0x0f;
            this.envHolding = true;
            this.envStep = 0;
          } else {
            if (this.envAlt) this.envAttack ^= 0x0f;
            this.envStep &= 0x0f;
          }
        }
        this.envVol = this.envStep ^ this.envAttack;
      }
    }
    const mix = r[7];
    let s = 0;
    for (let ch = 0; ch < 3; ch++) {
      const tone = this.toneOut[ch] | ((mix >> ch) & 1);
      const noise = this.noiseOut | ((mix >> (ch + 3)) & 1);
      if (tone & noise) {
        const amp = r[8 + ch];
        s += LEVELS[amp & 0x10 ? this.envVol : amp & 0x0f];
      }
    }
    return s;
  }

  /** Run the generator up to the given CPU cycle, producing audio samples if enabled. */
  advanceTo(cycle) {
    let delta = cycle - this.lastCycle + this.cycleFrac;
    this.lastCycle = cycle;
    if (delta <= 0) { this.cycleFrac = delta; return; }
    let ticks = Math.floor(delta / 8);
    this.cycleFrac = delta - ticks * 8;
    if (!this.enabled) {
      // Keep envelope/tone state roughly current without producing audio
      if (ticks > 4096) ticks = 4096;
      for (let i = 0; i < ticks; i++) this.tick();
      return;
    }
    const dac = this.dac / 128;
    for (let i = 0; i < ticks; i++) {
      this.acc += this.tick() / 3 + dac * 0.5;
      this.accN++;
      this.phase += this.step;
      if (this.phase >= 1) {
        this.phase -= 1;
        const raw = this.acc / this.accN;
        this.acc = 0; this.accN = 0;
        // DC-blocking high-pass filter
        this.dcOut = raw - this.dcPrev + 0.995 * this.dcOut;
        this.dcPrev = raw;
        if (this.outLen < this.out.length) this.out[this.outLen++] = this.dcOut * 0.6;
      }
    }
  }

  /** Returns and clears the samples generated so far. */
  drain() {
    const s = this.out.slice(0, this.outLen);
    this.outLen = 0;
    return s;
  }
}
