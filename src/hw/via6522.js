/**
 * MOS / Rockwell 6522 Versatile Interface Adapter.
 *
 * Emulated: ports A/B with data direction registers, timer 1 (one-shot and
 * free-running, optional PB7 output), timer 2 (one-shot interval mode),
 * the shift register (shift-out modes, which the Vectrex uses to drive the
 * BLANK line), CA2/CB2 manual output modes, IFR/IER and the IRQ output.
 *
 * Not emulated: handshake modes, CA1/CB1 edge interrupts, T2 pulse counting
 * and shift-in modes (the Vectrex does not rely on them).
 */

export const IFR_CA2 = 0x01;
export const IFR_CA1 = 0x02;
export const IFR_SR = 0x04;
export const IFR_CB2 = 0x08;
export const IFR_CB1 = 0x10;
export const IFR_T2 = 0x20;
export const IFR_T1 = 0x40;
export const IFR_IRQ = 0x80;

export class VIA6522 {
  /**
   * @param {object} [io]
   * @param {() => number} [io.readA]  value presented on the port A pins
   * @param {() => number} [io.readB]  value presented on the port B pins
   * @param {(reg:number) => void} [io.onWrite] called after a register write
   */
  constructor(io = {}) {
    this.io = io;
    this.reset();
  }

  reset() {
    this.ora = 0; this.orb = 0;
    this.ddra = 0; this.ddrb = 0;
    this.t1c = 0xffff; this.t1ll = 0xff; this.t1lh = 0xff;
    this.t2c = 0xffff; this.t2ll = 0xff;
    this.t1armed = false; this.t2armed = false;
    this.pb7 = 0x80; // T1 driven PB7 level (0x80 = high)
    this.sr = 0; this.srCount = 8; this.srClock = 0;
    this.acr = 0; this.pcr = 0;
    this.ifr = 0; this.ier = 0;
    this.ca2 = 1; this.cb2h = 1; // manual CA2 / CB2 output levels
    this.cb2s = 0; // CB2 level driven by the shift register
  }

  get irq() { return (this.ifr & this.ier & 0x7f) !== 0; }

  /** Effective CB2 level: shift register output when in a shift-out mode. */
  get cb2() { return this.acr & 0x10 ? this.cb2s : this.cb2h; }

  /** Effective PB7 level as 0x80/0. */
  get pb7Out() { return this.acr & 0x80 ? this.pb7 : this.orb & 0x80; }

  portA() {
    const pins = this.io.readA ? this.io.readA() : 0xff;
    return (this.ora & this.ddra) | (pins & ~this.ddra & 0xff);
  }

  portB() {
    const pins = this.io.readB ? this.io.readB() : 0xff;
    let v = (this.orb & this.ddrb) | (pins & ~this.ddrb & 0xff);
    if (this.acr & 0x80) v = (v & 0x7f) | this.pb7;
    return v;
  }

  read(reg) {
    switch (reg & 0x0f) {
      case 0x0: this.ifr &= ~(IFR_CB1 | IFR_CB2); return this.portB();
      case 0x1: this.ifr &= ~(IFR_CA1 | IFR_CA2); return this.portA();
      case 0x2: return this.ddrb;
      case 0x3: return this.ddra;
      case 0x4: this.ifr &= ~IFR_T1; return this.t1c & 0xff;
      case 0x5: return this.t1c >> 8;
      case 0x6: return this.t1ll;
      case 0x7: return this.t1lh;
      case 0x8: this.ifr &= ~IFR_T2; return this.t2c & 0xff;
      case 0x9: return this.t2c >> 8;
      case 0xa: this.ifr &= ~IFR_SR; this.srCount = 0; return this.sr;
      case 0xb: return this.acr;
      case 0xc: return this.pcr;
      case 0xd: return (this.ifr & 0x7f) | (this.irq ? IFR_IRQ : 0);
      case 0xe: return this.ier | 0x80;
      default: return this.portA(); // 0xF: ORA without handshake
    }
  }

  write(reg, v) {
    reg &= 0x0f; v &= 0xff;
    switch (reg) {
      case 0x0: this.orb = v; break;
      case 0x1: case 0xf: this.ora = v; if (reg === 1) this.ifr &= ~(IFR_CA1 | IFR_CA2); break;
      case 0x2: this.ddrb = v; break;
      case 0x3: this.ddra = v; break;
      case 0x4: case 0x6: this.t1ll = v; break;
      case 0x5: // T1 high: load counter and start
        this.t1lh = v;
        this.t1c = (this.t1lh << 8) | this.t1ll;
        this.ifr &= ~IFR_T1;
        this.t1armed = true;
        if (this.acr & 0x80) this.pb7 = 0;
        break;
      case 0x7: this.t1lh = v; this.ifr &= ~IFR_T1; break;
      case 0x8: this.t2ll = v; break;
      case 0x9:
        this.t2c = (v << 8) | this.t2ll;
        this.ifr &= ~IFR_T2;
        this.t2armed = true;
        break;
      case 0xa: this.sr = v; this.ifr &= ~IFR_SR; this.srCount = 0; break;
      case 0xb: this.acr = v; break;
      case 0xc:
        this.pcr = v;
        if ((v & 0x0e) === 0x0c) this.ca2 = 0; else if ((v & 0x0e) === 0x0e) this.ca2 = 1;
        if ((v & 0xe0) === 0xc0) this.cb2h = 0; else if ((v & 0xe0) === 0xe0) this.cb2h = 1;
        break;
      case 0xd: this.ifr &= ~(v & 0x7f); break;
      case 0xe:
        if (v & 0x80) this.ier |= v & 0x7f; else this.ier &= ~(v & 0x7f);
        break;
    }
    if (this.io.onWrite) this.io.onWrite(reg);
  }

  /** Advance the VIA by one phi2 clock cycle. */
  tick() {
    // Timer 1: interrupt when the counter rolls over from 0 to 0xFFFF.
    this.t1c = (this.t1c - 1) & 0xffff;
    if (this.t1c === 0xffff && this.t1armed) {
      this.ifr |= IFR_T1;
      if (this.acr & 0x40) { // free-running: reload, toggle PB7
        this.t1c = (this.t1lh << 8) | this.t1ll;
        this.pb7 ^= 0x80;
      } else {
        this.t1armed = false;
        this.pb7 = 0x80;
      }
    }
    // Timer 2 in one-shot interval mode
    if (!(this.acr & 0x20)) {
      this.t2c = (this.t2c - 1) & 0xffff;
      if (this.t2c === 0xffff && this.t2armed) {
        this.ifr |= IFR_T2;
        this.t2armed = false;
      }
    }
    // Shift register, shift-out under phi2 (mode 110): one bit every 2 cycles
    if ((this.acr & 0x1c) === 0x18 && this.srCount < 8) {
      this.srClock ^= 1;
      if (this.srClock === 0) {
        const bit = this.sr >> 7;
        this.sr = ((this.sr << 1) | bit) & 0xff;
        this.cb2s = bit;
        if (++this.srCount === 8) this.ifr |= IFR_SR;
      }
    }
  }
}
