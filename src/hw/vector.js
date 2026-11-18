/**
 * Vectrex analog vector generator.
 *
 * The VIA port A drives an 8-bit DAC. The DAC output feeds the X integrator
 * directly and, through an analog multiplexer selected by PB1-PB2 and enabled
 * by PB0 (active low), four sample-and-hold circuits:
 *
 *   mux 0  Y integrator input
 *   mux 1  zero reference / offset ("RAMP offset")
 *   mux 2  Z axis (beam brightness)
 *   mux 3  sound output
 *
 * Control lines:
 *   RAMP  (PB7, normally driven by VIA timer 1)  low  = integrators run
 *   ZERO  (CA2)                                  low  = integrators reset to 0
 *   BLANK (CB2, normally the shift register)     high = beam on
 *
 * The "scale" of a vector is simply how long RAMP stays low, i.e. the T1
 * count. Every cycle the beam position moves by (input - offset); runs of
 * cycles with constant velocity and brightness are emitted as line segments.
 */

export const SCREEN_W = 33000; // integrator units, roughly the visible tube area
export const SCREEN_H = 41000;
const LIMIT = 60000;
const SEG_FIELDS = 7;

export class VectorGenerator {
  constructor(maxSegments = 32768) {
    this.max = maxSegments;
    /** x0, y0, x1, y1, brightness (0..127), dwell cycles, end cycle */
    this.segments = new Float64Array(maxSegments * SEG_FIELDS);
    this.count = 0;
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0;
    this.xsh = 0; this.ysh = 0; this.rsh = 0; this.zsh = 0;
    this.open = false;
    this.sx = 0; this.sy = 0; this.svx = 0; this.svy = 0; this.sz = 0; this.dwell = 0;
    this.count = 0;
  }

  /**
   * Update DAC and sample/hold values. `dac` is the signed DAC value,
   * `orb` the VIA port B output. Returns the mux channel that was sampled
   * (or -1 if the mux is disabled) so the caller can route sound.
   */
  setDac(dac, orb) {
    this.xsh = dac;
    if (orb & 0x01) return -1;
    const sel = (orb >> 1) & 3;
    if (sel === 0) this.ysh = dac;
    else if (sel === 1) this.rsh = dac;
    else if (sel === 2) this.zsh = dac;
    return sel;
  }

  /**
   * Advance one cycle.
   * @param {number} cycle current CPU cycle (for timestamps)
   * @param {boolean} ramp  true when integrators are running (RAMP low)
   * @param {boolean} zero  true when ZERO is asserted
   * @param {boolean} beam  true when BLANK is high (beam enabled)
   */
  tick(cycle, ramp, zero, beam) {
    if (zero) {
      if (this.open) this.flush(cycle);
      this.x = 0; this.y = 0;
      return;
    }
    let vx = 0, vy = 0;
    if (ramp) { vx = this.xsh - this.rsh; vy = this.ysh - this.rsh; }
    const z = this.zsh;
    if (beam && z > 0) {
      if (!this.open || vx !== this.svx || vy !== this.svy || z !== this.sz) {
        if (this.open) this.flush(cycle);
        this.open = true;
        this.sx = this.x; this.sy = this.y;
        this.svx = vx; this.svy = vy; this.sz = z; this.dwell = 0;
      }
      this.dwell++;
    } else if (this.open) {
      this.flush(cycle);
    }
    if (vx || vy) {
      this.x += vx; this.y += vy;
      if (this.x > LIMIT) this.x = LIMIT; else if (this.x < -LIMIT) this.x = -LIMIT;
      if (this.y > LIMIT) this.y = LIMIT; else if (this.y < -LIMIT) this.y = -LIMIT;
    }
  }

  flush(cycle) {
    this.open = false;
    if (this.count >= this.max) return;
    const i = this.count++ * SEG_FIELDS, s = this.segments;
    s[i] = this.sx; s[i + 1] = this.sy; s[i + 2] = this.x; s[i + 3] = this.y;
    s[i + 4] = this.sz; s[i + 5] = this.dwell; s[i + 6] = cycle;
  }

  /** Close any open segment so it can be rendered now (it continues afterwards). */
  cut(cycle) {
    if (!this.open) return;
    const { svx, svy, sz } = this;
    this.flush(cycle);
    this.open = true;
    this.sx = this.x; this.sy = this.y; this.svx = svx; this.svy = svy; this.sz = sz; this.dwell = 0;
  }

  clear() { this.count = 0; }
}

VectorGenerator.FIELDS = SEG_FIELDS;
