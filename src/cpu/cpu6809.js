/**
 * Motorola 6809 CPU core.
 *
 * - All documented opcodes of pages 0, 2 (0x10) and 3 (0x11)
 * - All addressing modes: inherent, immediate, direct, extended, relative
 *   (short and long) and every indexed sub-mode, including indirection
 * - Cycle counts from the Motorola datasheet, indexed extra cycles included
 * - IRQ / FIRQ / NMI, SWI/SWI2/SWI3, CWAI and SYNC
 *
 * The bus is any object exposing read(addr) -> byte and write(addr, byte).
 */

export const FLAG_C = 0x01;
export const FLAG_V = 0x02;
export const FLAG_Z = 0x04;
export const FLAG_N = 0x08;
export const FLAG_I = 0x10;
export const FLAG_H = 0x20;
export const FLAG_F = 0x40;
export const FLAG_E = 0x80;

const C = FLAG_C, V = FLAG_V, Z = FLAG_Z, N = FLAG_N;
const I = FLAG_I, H = FLAG_H, F = FLAG_F, E = FLAG_E;

const VEC_SWI3 = 0xfff2;
const VEC_SWI2 = 0xfff4;
const VEC_FIRQ = 0xfff6;
const VEC_IRQ = 0xfff8;
const VEC_SWI = 0xfffa;
const VEC_NMI = 0xfffc;
const VEC_RESET = 0xfffe;

const sex8 = (v) => (v & 0x80 ? v - 0x100 : v);
const sex16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

export class CPU6809 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.dp = 0; this.cc = I | F;
    this.x = 0; this.y = 0; this.u = 0; this.s = 0; this.pc = 0;
    /** Total cycles executed since construction. */
    this.cycles = 0;
    /** Interrupt input lines (level sensitive for IRQ/FIRQ). */
    this.irq = false;
    this.firq = false;
    this.nmiPending = false;
    this.nmiArmed = false;
    this.waiting = false; // CWAI
    this.syncing = false; // SYNC
    this.illegal = 0; // count of illegal opcodes met (diagnostics)
    this.extra = 0;
  }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xff; this.b = v & 0xff; }

  reset() {
    this.cc = I | F;
    this.dp = 0;
    this.waiting = false;
    this.syncing = false;
    this.nmiPending = false;
    this.nmiArmed = false;
    this.pc = this.read16(VEC_RESET);
  }

  /** Edge-triggered NMI request. Ignored until S has been loaded once. */
  nmi() { this.nmiPending = true; }

  // ---------------------------------------------------------------- memory
  read8(addr) { return this.bus.read(addr & 0xffff); }
  write8(addr, v) { this.bus.write(addr & 0xffff, v & 0xff); }
  read16(addr) { return (this.read8(addr) << 8) | this.read8(addr + 1); }
  write16(addr, v) { this.write8(addr, v >> 8); this.write8(addr + 1, v); }

  fetch8() { const v = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const hi = this.fetch8(); return (hi << 8) | this.fetch8(); }

  pushS8(v) { this.s = (this.s - 1) & 0xffff; this.write8(this.s, v); }
  pushS16(v) { this.pushS8(v); this.pushS8(v >> 8); }
  pullS8() { const v = this.read8(this.s); this.s = (this.s + 1) & 0xffff; return v; }
  pullS16() { const hi = this.pullS8(); return (hi << 8) | this.pullS8(); }

  /** Push the whole machine state on S (used by SWI, IRQ, NMI, CWAI). */
  pushAll() {
    this.pushS16(this.pc); this.pushS16(this.u); this.pushS16(this.y); this.pushS16(this.x);
    this.pushS8(this.dp); this.pushS8(this.b); this.pushS8(this.a); this.pushS8(this.cc);
  }

  // ------------------------------------------------------------- execution
  /** Execute one instruction (or take one interrupt). Returns cycles used. */
  step() {
    const c = this.stepInner();
    this.cycles += c;
    return c;
  }

  stepInner() {
    // Interrupts, in priority order
    if (this.nmiPending && this.nmiArmed) {
      this.nmiPending = false;
      if (!this.waiting) { this.cc |= E; this.pushAll(); }
      this.waiting = this.syncing = false;
      this.cc |= I | F;
      this.pc = this.read16(VEC_NMI);
      return 19;
    }
    if (this.firq && !(this.cc & F)) {
      if (!this.waiting) { this.cc &= ~E; this.pushS16(this.pc); this.pushS8(this.cc); }
      this.waiting = this.syncing = false;
      this.cc |= I | F;
      this.pc = this.read16(VEC_FIRQ);
      return 10;
    }
    if (this.irq && !(this.cc & I)) {
      if (!this.waiting) { this.cc |= E; this.pushAll(); }
      this.waiting = this.syncing = false;
      this.cc |= I;
      this.pc = this.read16(VEC_IRQ);
      return 19;
    }
    if (this.waiting) return 1;
    if (this.syncing) {
      // SYNC resumes on any interrupt line, even when masked.
      if (this.irq || this.firq || this.nmiPending) this.syncing = false;
      else return 1;
    }

    this.extra = 0;
    const op = this.fetch8();
    if (op === 0x10) return this.page2(this.fetch8());
    if (op === 0x11) return this.page3(this.fetch8());
    return this.page0(op);
  }

  // ---------------------------------------------------------- flag helpers
  nz8(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x80 ? N : 0) | (r & 0xff ? 0 : Z); }
  nz16(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x8000 ? N : 0) | (r & 0xffff ? 0 : Z); }

  add8(a, b, carry) {
    const r = a + b + carry;
    this.cc = (this.cc & ~(H | N | Z | V | C)) |
      ((a ^ b ^ r) & 0x10 ? H : 0) |
      (r & 0x80 ? N : 0) |
      (r & 0xff ? 0 : Z) |
      ((a ^ r) & (b ^ r) & 0x80 ? V : 0) |
      (r & 0x100 ? C : 0);
    return r & 0xff;
  }

  sub8(a, b, borrow) {
    const r = a - b - borrow;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x80 ? N : 0) |
      (r & 0xff ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x80 ? V : 0) |
      (r & 0x100 ? C : 0);
    return r & 0xff;
  }

  add16(a, b) {
    const r = a + b;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x8000 ? N : 0) |
      (r & 0xffff ? 0 : Z) |
      ((a ^ r) & (b ^ r) & 0x8000 ? V : 0) |
      (r & 0x10000 ? C : 0);
    return r & 0xffff;
  }

  sub16(a, b) {
    const r = a - b;
    this.cc = (this.cc & ~(N | Z | V | C)) |
      (r & 0x8000 ? N : 0) |
      (r & 0xffff ? 0 : Z) |
      ((a ^ b) & (a ^ r) & 0x8000 ? V : 0) |
      (r & 0x10000 ? C : 0);
    return r & 0xffff;
  }

  /** Read-modify-write unary operations shared by memory, A and B forms. */
  rmw(sub, m) {
    let r;
    const cc = this.cc;
    switch (sub) {
      case 0x0: return this.sub8(0, m, 0); // NEG
      case 0x3: // COM
        r = ~m & 0xff;
        this.cc = (cc & ~(N | Z | V)) | C; this.nz8(r);
        return r;
      case 0x4: // LSR
        r = m >> 1;
        this.cc = (cc & ~(N | Z | C)) | (m & 1 ? C : 0) | (r ? 0 : Z);
        return r;
      case 0x6: // ROR
        r = (m >> 1) | (cc & C ? 0x80 : 0);
        this.cc = (cc & ~C) | (m & 1 ? C : 0); this.nz8(r);
        return r;
      case 0x7: // ASR
        r = (m >> 1) | (m & 0x80);
        this.cc = (cc & ~C) | (m & 1 ? C : 0); this.nz8(r);
        return r;
      case 0x8: // ASL / LSL
        r = (m << 1) & 0xff;
        this.cc = (cc & ~(V | C)) | (m & 0x80 ? C : 0) | ((m ^ (m << 1)) & 0x80 ? V : 0); this.nz8(r);
        return r;
      case 0x9: // ROL
        r = ((m << 1) | (cc & C)) & 0xff;
        this.cc = (cc & ~(V | C)) | (m & 0x80 ? C : 0) | ((m ^ (m << 1)) & 0x80 ? V : 0); this.nz8(r);
        return r;
      case 0xa: // DEC
        r = (m - 1) & 0xff;
        this.cc = (cc & ~V) | (m === 0x80 ? V : 0); this.nz8(r);
        return r;
      case 0xc: // INC
        r = (m + 1) & 0xff;
        this.cc = (cc & ~V) | (m === 0x7f ? V : 0); this.nz8(r);
        return r;
      case 0xd: // TST
        this.cc = cc & ~V; this.nz8(m);
        return m;
      case 0xf: // CLR
        this.cc = (cc & ~(N | V | C)) | Z;
        return 0;
      default:
        return -1; // illegal
    }
  }

  // ------------------------------------------------------ addressing modes
  direct() { return (this.dp << 8) | this.fetch8(); }
  extended() { return this.fetch16(); }

  ireg(r) { return r === 0 ? this.x : r === 1 ? this.y : r === 2 ? this.u : this.s; }
  setIreg(r, v) {
    v &= 0xffff;
    if (r === 0) this.x = v; else if (r === 1) this.y = v; else if (r === 2) this.u = v;
    else { this.s = v; this.nmiArmed = true; }
  }

  /** Decode an indexed postbyte; returns the effective address and adds extra cycles. */
  indexed() {
    const pb = this.fetch8();
    const r = (pb >> 5) & 3;
    let ea;
    if (!(pb & 0x80)) {
      // 5-bit signed offset, never indirect
      const off = pb & 0x10 ? (pb & 0x1f) - 0x20 : pb & 0x0f;
      this.extra += 1;
      return (this.ireg(r) + off) & 0xffff;
    }
    switch (pb & 0x0f) {
      case 0x0: ea = this.ireg(r); this.setIreg(r, ea + 1); this.extra += 2; break; // ,R+
      case 0x1: ea = this.ireg(r); this.setIreg(r, ea + 2); this.extra += 3; break; // ,R++
      case 0x2: ea = (this.ireg(r) - 1) & 0xffff; this.setIreg(r, ea); this.extra += 2; break; // ,-R
      case 0x3: ea = (this.ireg(r) - 2) & 0xffff; this.setIreg(r, ea); this.extra += 3; break; // ,--R
      case 0x4: ea = this.ireg(r); break; // ,R
      case 0x5: ea = this.ireg(r) + sex8(this.b); this.extra += 1; break; // B,R
      case 0x6: ea = this.ireg(r) + sex8(this.a); this.extra += 1; break; // A,R
      case 0x8: ea = this.ireg(r) + sex8(this.fetch8()); this.extra += 1; break; // n8,R
      case 0x9: ea = this.ireg(r) + this.fetch16(); this.extra += 4; break; // n16,R
      case 0xb: ea = this.ireg(r) + this.d; this.extra += 4; break; // D,R
      case 0xc: { const o = sex8(this.fetch8()); ea = this.pc + o; this.extra += 1; break; } // n8,PCR
      case 0xd: { const o = this.fetch16(); ea = this.pc + o; this.extra += 5; break; } // n16,PCR
      case 0xf: ea = this.fetch16(); this.extra += 2; break; // [n16] (indirect only)
      default: ea = this.ireg(r); this.illegal++; break; // 0x7, 0xA, 0xE: undefined
    }
    ea &= 0xffff;
    if (pb & 0x10) { ea = this.read16(ea); this.extra += 3; }
    return ea;
  }

  /** Effective address for modes 1=direct, 2=indexed, 3=extended. */
  ea(mode) { return mode === 1 ? this.direct() : mode === 2 ? this.indexed() : this.extended(); }
  operand8(mode) { return mode === 0 ? this.fetch8() : this.read8(this.ea(mode)); }
  operand16(mode) { return mode === 0 ? this.fetch16() : this.read16(this.ea(mode)); }

  // ------------------------------------------------------------- branches
  cond(op) {
    const cc = this.cc;
    switch (op & 0x0f) {
      case 0x0: return true; // BRA
      case 0x1: return false; // BRN
      case 0x2: return !(cc & (C | Z)); // BHI
      case 0x3: return !!(cc & (C | Z)); // BLS
      case 0x4: return !(cc & C); // BCC/BHS
      case 0x5: return !!(cc & C); // BCS/BLO
      case 0x6: return !(cc & Z); // BNE
      case 0x7: return !!(cc & Z); // BEQ
      case 0x8: return !(cc & V); // BVC
      case 0x9: return !!(cc & V); // BVS
      case 0xa: return !(cc & N); // BPL
      case 0xb: return !!(cc & N); // BMI
      case 0xc: return !(cc & N) === !(cc & V); // BGE
      case 0xd: return !(cc & N) !== !(cc & V); // BLT
      case 0xe: return !(cc & Z) && !(cc & N) === !(cc & V); // BGT
      default: return !!(cc & Z) || !(cc & N) !== !(cc & V); // BLE
    }
  }

  // ------------------------------------------------- register transfers
  getReg(code) {
    switch (code) {
      case 0x0: return this.d; case 0x1: return this.x; case 0x2: return this.y;
      case 0x3: return this.u; case 0x4: return this.s; case 0x5: return this.pc;
      case 0x8: return this.a; case 0x9: return this.b; case 0xa: return this.cc;
      case 0xb: return this.dp; default: return 0xff;
    }
  }
  setReg(code, v) {
    switch (code) {
      case 0x0: this.d = v; break; case 0x1: this.x = v & 0xffff; break;
      case 0x2: this.y = v & 0xffff; break; case 0x3: this.u = v & 0xffff; break;
      case 0x4: this.s = v & 0xffff; this.nmiArmed = true; break;
      case 0x5: this.pc = v & 0xffff; break; case 0x8: this.a = v & 0xff; break;
      case 0x9: this.b = v & 0xff; break; case 0xa: this.cc = v & 0xff; break;
      case 0xb: this.dp = v & 0xff; break; default: break;
    }
  }
  /** Value of register `from` converted to the width of register `to`. */
  convert(v, from, to) {
    const wideFrom = from < 8, wideTo = to < 8;
    if (wideFrom === wideTo) return v;
    return wideTo ? 0xff00 | v : v & 0xff;
  }

  // -------------------------------------------------------- stack ops
  psh(pb, useU) {
    let cyc = 5;
    const push8 = (v) => {
      if (useU) { this.u = (this.u - 1) & 0xffff; this.write8(this.u, v); }
      else { this.s = (this.s - 1) & 0xffff; this.write8(this.s, v); }
      cyc++;
    };
    const push16 = (v) => { push8(v); push8(v >> 8); };
    if (pb & 0x80) push16(this.pc);
    if (pb & 0x40) push16(useU ? this.s : this.u);
    if (pb & 0x20) push16(this.y);
    if (pb & 0x10) push16(this.x);
    if (pb & 0x08) push8(this.dp);
    if (pb & 0x04) push8(this.b);
    if (pb & 0x02) push8(this.a);
    if (pb & 0x01) push8(this.cc);
    return cyc;
  }

  pul(pb, useU) {
    let cyc = 5;
    const pull8 = () => {
      let v;
      if (useU) { v = this.read8(this.u); this.u = (this.u + 1) & 0xffff; }
      else { v = this.read8(this.s); this.s = (this.s + 1) & 0xffff; }
      cyc++;
      return v;
    };
    const pull16 = () => { const hi = pull8(); return (hi << 8) | pull8(); };
    if (pb & 0x01) this.cc = pull8();
    if (pb & 0x02) this.a = pull8();
    if (pb & 0x04) this.b = pull8();
    if (pb & 0x08) this.dp = pull8();
    if (pb & 0x10) this.x = pull16();
    if (pb & 0x20) this.y = pull16();
    if (pb & 0x40) { if (useU) { this.s = pull16(); this.nmiArmed = true; } else this.u = pull16(); }
    if (pb & 0x80) this.pc = pull16();
    return cyc;
  }

  swi(vector, mask) {
    this.cc |= E;
    this.pushAll();
    if (mask) this.cc |= I | F;
    this.pc = this.read16(vector);
  }

  // ------------------------------------------------------------- page 0
  page0(op) {
    const hi = op >> 4;

    // Memory read-modify-write: 0x0_ direct, 0x6_ indexed, 0x7_ extended
    if (hi === 0x0 || hi === 0x6 || hi === 0x7) {
      const sub = op & 0x0f;
      const mode = hi === 0 ? 1 : hi === 6 ? 2 : 3;
      const ea = this.ea(mode);
      const base = mode === 3 ? 7 : 6;
      if (sub === 0xe) { this.pc = ea; return base - 3 + this.extra; } // JMP
      if (sub === 0xd) { this.rmw(0xd, this.read8(ea)); return base + this.extra; } // TST
      if (sub === 0xf) { this.read8(ea); this.write8(ea, this.rmw(0xf, 0)); return base + this.extra; } // CLR
      const r = this.rmw(sub, this.read8(ea));
      if (r < 0) { this.illegal++; return 2; }
      this.write8(ea, r);
      return base + this.extra;
    }
    // Inherent accumulator forms: 0x4_ (A), 0x5_ (B)
    if (hi === 0x4 || hi === 0x5) {
      const sub = op & 0x0f;
      const r = this.rmw(sub, hi === 4 ? this.a : this.b);
      if (r < 0) { this.illegal++; return 2; }
      if (hi === 4) this.a = r; else this.b = r;
      return 2;
    }
    if (op >= 0x80) return this.alu(op);

    switch (op) {
      case 0x12: return 2; // NOP
      case 0x13: this.syncing = true; return 4; // SYNC
      case 0x16: { const o = this.fetch16(); this.pc = (this.pc + o) & 0xffff; return 5; } // LBRA
      case 0x17: { const o = this.fetch16(); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xffff; return 9; } // LBSR
      case 0x19: { // DAA
        const a = this.a, lsn = a & 0x0f, msn = a & 0xf0;
        let cf = 0;
        if (this.cc & H || lsn > 9) cf |= 0x06;
        if (this.cc & C || msn > 0x90 || (msn > 0x80 && lsn > 9)) cf |= 0x60;
        const t = a + cf;
        this.a = t & 0xff;
        this.cc = (this.cc & ~(N | Z | V)) | (t & 0x100 ? C : 0);
        this.nz8(this.a);
        return 2;
      }
      case 0x1a: this.cc |= this.fetch8(); return 3; // ORCC
      case 0x1c: this.cc &= this.fetch8(); return 3; // ANDCC
      case 0x1d: this.a = this.b & 0x80 ? 0xff : 0; this.nz16(this.d); return 2; // SEX
      case 0x1e: { // EXG
        const pb = this.fetch8(), r1 = pb >> 4, r2 = pb & 0x0f;
        const v1 = this.getReg(r1), v2 = this.getReg(r2);
        this.setReg(r1, this.convert(v2, r2, r1));
        this.setReg(r2, this.convert(v1, r1, r2));
        return 8;
      }
      case 0x1f: { // TFR
        const pb = this.fetch8(), r1 = pb >> 4, r2 = pb & 0x0f;
        this.setReg(r2, this.convert(this.getReg(r1), r1, r2));
        return 6;
      }
      case 0x30: { const ea = this.indexed(); this.x = ea; this.cc = (this.cc & ~Z) | (ea ? 0 : Z); return 4 + this.extra; } // LEAX
      case 0x31: { const ea = this.indexed(); this.y = ea; this.cc = (this.cc & ~Z) | (ea ? 0 : Z); return 4 + this.extra; } // LEAY
      case 0x32: this.s = this.indexed(); this.nmiArmed = true; return 4 + this.extra; // LEAS
      case 0x33: this.u = this.indexed(); return 4 + this.extra; // LEAU
      case 0x34: return this.psh(this.fetch8(), false); // PSHS
      case 0x35: return this.pul(this.fetch8(), false); // PULS
      case 0x36: return this.psh(this.fetch8(), true); // PSHU
      case 0x37: return this.pul(this.fetch8(), true); // PULU
      case 0x39: this.pc = this.pullS16(); return 5; // RTS
      case 0x3a: this.x = (this.x + this.b) & 0xffff; return 3; // ABX
      case 0x3b: { // RTI
        this.cc = this.pullS8();
        if (this.cc & E) {
          this.a = this.pullS8(); this.b = this.pullS8(); this.dp = this.pullS8();
          this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
          this.pc = this.pullS16();
          return 15;
        }
        this.pc = this.pullS16();
        return 6;
      }
      case 0x3c: // CWAI
        this.cc &= this.fetch8();
        this.cc |= E;
        this.pushAll();
        this.waiting = true;
        return 20;
      case 0x3d: { // MUL
        const r = this.a * this.b;
        this.d = r;
        this.cc = (this.cc & ~(Z | C)) | (r ? 0 : Z) | (r & 0x80 ? C : 0);
        return 11;
      }
      case 0x3f: this.swi(VEC_SWI, true); return 19; // SWI
      default:
        if (op >= 0x20 && op <= 0x2f) { // short branches
          const o = sex8(this.fetch8());
          if (this.cond(op)) this.pc = (this.pc + o) & 0xffff;
          return 3;
        }
        this.illegal++;
        return 2;
    }
  }

  /** Opcodes 0x80-0xFF: accumulator / 16-bit register ALU group. */
  alu(op) {
    const isB = (op & 0x40) !== 0;
    const mode = (op >> 4) & 3; // 0 imm, 1 dir, 2 idx, 3 ext
    const sub = op & 0x0f;
    const cyc8 = mode === 0 ? 2 : mode === 3 ? 5 : 4;

    switch (sub) {
      case 0x0: case 0x1: case 0x2: case 0x4: case 0x5: case 0x6:
      case 0x8: case 0x9: case 0xa: case 0xb: {
        const m = this.operand8(mode);
        const acc = isB ? this.b : this.a;
        let r = acc;
        switch (sub) {
          case 0x0: r = this.sub8(acc, m, 0); break; // SUB
          case 0x1: this.sub8(acc, m, 0); return cyc8 + this.extra; // CMP
          case 0x2: r = this.sub8(acc, m, this.cc & C); break; // SBC
          case 0x4: r = acc & m; this.cc &= ~V; this.nz8(r); break; // AND
          case 0x5: this.cc &= ~V; this.nz8(acc & m); return cyc8 + this.extra; // BIT
          case 0x6: r = m; this.cc &= ~V; this.nz8(r); break; // LD
          case 0x8: r = acc ^ m; this.cc &= ~V; this.nz8(r); break; // EOR
          case 0x9: r = this.add8(acc, m, this.cc & C); break; // ADC
          case 0xa: r = acc | m; this.cc &= ~V; this.nz8(r); break; // OR
          case 0xb: r = this.add8(acc, m, 0); break; // ADD
        }
        if (isB) this.b = r; else this.a = r;
        return cyc8 + this.extra;
      }
      case 0x7: { // STA / STB
        if (mode === 0) { this.illegal++; return 2; }
        const ea = this.ea(mode);
        const v = isB ? this.b : this.a;
        this.write8(ea, v);
        this.cc &= ~V; this.nz8(v);
        return cyc8 + this.extra;
      }
      case 0x3: { // SUBD (A side) / ADDD (B side)
        const m = this.operand16(mode);
        this.d = isB ? this.add16(this.d, m) : this.sub16(this.d, m);
        return [4, 6, 6, 7][mode] + this.extra;
      }
      case 0xc: { // CMPX (A side) / LDD (B side)
        const m = this.operand16(mode);
        if (isB) { this.d = m; this.cc &= ~V; this.nz16(m); return [3, 5, 5, 6][mode] + this.extra; }
        this.sub16(this.x, m);
        return [4, 6, 6, 7][mode] + this.extra;
      }
      case 0xd: { // BSR / JSR (A side), STD (B side)
        if (isB) {
          if (mode === 0) { this.illegal++; return 2; }
          const ea = this.ea(mode);
          this.write16(ea, this.d); this.cc &= ~V; this.nz16(this.d);
          return [0, 5, 5, 6][mode] + this.extra;
        }
        if (mode === 0) { // BSR
          const o = sex8(this.fetch8());
          this.pushS16(this.pc);
          this.pc = (this.pc + o) & 0xffff;
          return 7;
        }
        const ea = this.ea(mode);
        this.pushS16(this.pc);
        this.pc = ea;
        return [0, 7, 7, 8][mode] + this.extra;
      }
      case 0xe: { // LDX / LDU
        const m = this.operand16(mode);
        if (isB) this.u = m; else this.x = m;
        this.cc &= ~V; this.nz16(m);
        return [3, 5, 5, 6][mode] + this.extra;
      }
      case 0xf: { // STX / STU
        if (mode === 0) { this.illegal++; return 2; }
        const ea = this.ea(mode);
        const v = isB ? this.u : this.x;
        this.write16(ea, v); this.cc &= ~V; this.nz16(v);
        return [0, 5, 5, 6][mode] + this.extra;
      }
    }
    this.illegal++;
    return 2;
  }

  // ------------------------------------------------------------- page 2
  page2(op) {
    if (op >= 0x21 && op <= 0x2f) { // long conditional branches
      const o = this.fetch16();
      if (this.cond(op)) { this.pc = (this.pc + o) & 0xffff; return 6; }
      return 5;
    }
    if (op === 0x3f) { this.swi(VEC_SWI2, false); return 20; }
    const mode = (op >> 4) & 3;
    switch (op) {
      case 0x83: case 0x93: case 0xa3: case 0xb3: // CMPD
        this.sub16(this.d, this.operand16(mode)); return [5, 7, 7, 8][mode] + this.extra;
      case 0x8c: case 0x9c: case 0xac: case 0xbc: // CMPY
        this.sub16(this.y, this.operand16(mode)); return [5, 7, 7, 8][mode] + this.extra;
      case 0x8e: case 0x9e: case 0xae: case 0xbe: // LDY
        this.y = this.operand16(mode); this.cc &= ~V; this.nz16(this.y); return [4, 6, 6, 7][mode] + this.extra;
      case 0x9f: case 0xaf: case 0xbf: { // STY
        const ea = this.ea(mode); this.write16(ea, this.y); this.cc &= ~V; this.nz16(this.y);
        return [0, 6, 6, 7][mode] + this.extra;
      }
      case 0xce: case 0xde: case 0xee: case 0xfe: // LDS
        this.s = this.operand16(mode); this.nmiArmed = true; this.cc &= ~V; this.nz16(this.s);
        return [4, 6, 6, 7][mode] + this.extra;
      case 0xdf: case 0xef: case 0xff: { // STS
        const ea = this.ea(mode); this.write16(ea, this.s); this.cc &= ~V; this.nz16(this.s);
        return [0, 6, 6, 7][mode] + this.extra;
      }
    }
    this.illegal++;
    return 2;
  }

  // ------------------------------------------------------------- page 3
  page3(op) {
    if (op === 0x3f) { this.swi(VEC_SWI3, false); return 20; }
    const mode = (op >> 4) & 3;
    switch (op) {
      case 0x83: case 0x93: case 0xa3: case 0xb3: // CMPU
        this.sub16(this.u, this.operand16(mode)); return [5, 7, 7, 8][mode] + this.extra;
      case 0x8c: case 0x9c: case 0xac: case 0xbc: // CMPS
        this.sub16(this.s, this.operand16(mode)); return [5, 7, 7, 8][mode] + this.extra;
    }
    this.illegal++;
    return 2;
  }
}

export { sex8, sex16 };
