/**
 * The Vectrex machine: memory map and glue between the CPU, the VIA,
 * the PSG and the analog vector generator.
 *
 * Memory map
 *   0000-7FFF  cartridge ROM (32 KB window)
 *   8000-C7FF  unmapped
 *   C800-CFFF  1 KB RAM (mirrored)
 *   D000-D7FF  VIA 6522 (16 registers, mirrored)
 *   D800-DFFF  RAM and VIA both selected
 *   E000-FFFF  8 KB system ROM (BIOS) - or the built-in demo
 *
 * VIA wiring
 *   Port A   DAC and PSG data bus
 *   PB0      mux enable (active low)      PB1-2  mux select
 *   PB3      PSG BC1                      PB4    PSG BDIR
 *   PB5      joystick comparator input    PB6    cartridge line
 *   PB7      RAMP (driven by timer 1)
 *   CA2      ZERO                         CB2    BLANK (shift register)
 */

import { CPU6809 } from './cpu/cpu6809.js';
import { VIA6522 } from './hw/via6522.js';
import { AY38912 } from './hw/ay38912.js';
import { VectorGenerator } from './hw/vector.js';

export const CPU_HZ = 1500000;
export const FRAME_CYCLES = 30000; // the BIOS refreshes the screen at 50 Hz

export class Vectrex {
  constructor({ sampleRate = 48000 } = {}) {
    this.ram = new Uint8Array(1024);
    this.rom = new Uint8Array(8192).fill(0xff);
    this.cart = new Uint8Array(0);
    this.vector = new VectorGenerator();
    this.psg = new AY38912({ clock: CPU_HZ, sampleRate });
    this.psgAddr = 0;
    this.psgLatch = 0xff;
    this.compare = 0;
    /** Joystick pot values (0..255, 0x80 = centre): P1 X, P1 Y, P2 X, P2 Y */
    this.joy = new Uint8Array([0x80, 0x80, 0x80, 0x80]);
    /** Buttons, active low: bits 0-3 player 1, bits 4-7 player 2 */
    this.buttons = 0xff;
    this.psg.portAInput = () => this.buttons;

    this.via = new VIA6522({
      readA: () => this.psgLatch,
      readB: () => this.compare,
      onWrite: (reg) => this.viaWritten(reg),
    });
    this.cpu = new CPU6809(this);
    this.frameSync = false;
  }

  // ------------------------------------------------------------ loading
  loadSystemRom(bytes) {
    const data = new Uint8Array(bytes);
    this.rom = new Uint8Array(8192).fill(0xff);
    if (data.length === 4096) { this.rom.set(data, 0); this.rom.set(data, 4096); }
    else this.rom.set(data.subarray(0, 8192), 8192 - Math.min(8192, data.length));
  }

  loadCartridge(bytes) { this.cart = new Uint8Array(bytes).slice(0, 0x8000); }
  ejectCartridge() { this.cart = new Uint8Array(0); }

  reset() {
    this.ram.fill(0);
    this.via.reset();
    this.vector.reset();
    this.psg.reset(this.cpu.cycles);
    this.psgAddr = 0; this.psgLatch = 0xff; this.compare = 0;
    this.cpu.reset();
  }

  // ---------------------------------------------------------------- bus
  read(addr) {
    if (addr < 0x8000) return addr < this.cart.length ? this.cart[addr] : 0xff;
    if (addr >= 0xe000) return this.rom[addr & 0x1fff];
    if (addr >= 0xd000) {
      if (addr < 0xd800) return this.via.read(addr & 0x0f);
      return this.via.read(addr & 0x0f) & this.ram[addr & 0x3ff];
    }
    if (addr >= 0xc800) return this.ram[addr & 0x3ff];
    return 0xff;
  }

  write(addr, v) {
    if (addr < 0xc800 || addr >= 0xe000) return; // ROM / unmapped
    if (addr < 0xd000) { this.ram[addr & 0x3ff] = v; return; }
    if (addr >= 0xd800) this.ram[addr & 0x3ff] = v;
    this.via.write(addr & 0x0f, v);
  }

  // ----------------------------------------------------- analog / sound
  viaWritten(reg) {
    if (reg === 0x09) this.frameSync = true; // T2 re-armed: the BIOS frame timer
    if (reg > 3 && reg !== 0x0f) return;
    const via = this.via;
    const orb = via.orb;
    const pa = (via.ora & via.ddra) | (this.psgLatch & ~via.ddra & 0xff);
    const dac = pa & 0x80 ? pa - 0x100 : pa;

    const sel = this.vector.setDac(dac, orb);
    if (sel === 3) this.psg.setDac(dac, this.cpu.cycles);
    if (!(orb & 0x01)) {
      // Joystick comparator: PB5 high when the selected pot is above the DAC
      const pot = this.joy[(orb >> 1) & 3];
      this.compare = pot > (pa ^ 0x80) ? 0x20 : 0;
    }

    // PSG bus control: BDIR = PB4, BC1 = PB3
    const bdir = orb & 0x10, bc1 = orb & 0x08;
    if (bdir && bc1) this.psgAddr = via.ora & 0x0f; // latch address
    else if (bdir) this.psg.write(this.psgAddr, via.ora, this.cpu.cycles); // write data
    else if (bc1) this.psgLatch = this.psg.read(this.psgAddr); // read data
    else this.psgLatch = 0xff;
  }

  // ------------------------------------------------------------ running
  /** Run for (at least) the given number of CPU cycles. */
  run(cycles) { return this.execute(cycles, false); }

  execute(cycles, stopOnSync) {
    const cpu = this.cpu, via = this.via, vec = this.vector;
    const target = cpu.cycles + cycles;
    let now = cpu.cycles;
    while (now < target) {
      if (stopOnSync && this.frameSync) break;
      cpu.irq = via.irq;
      const n = cpu.step();
      for (let i = 0; i < n; i++) {
        via.tick();
        const ramp = (via.acr & 0x80 ? via.pb7 : via.orb & 0x80) === 0;
        const beam = (via.acr & 0x10 ? via.cb2s : via.cb2h) !== 0;
        vec.tick(now++, ramp, via.ca2 === 0, beam);
      }
    }
    vec.cut(now);
    this.psg.advanceTo(now);
    return now;
  }

  /**
   * Run one display frame: until the program re-arms VIA timer 2 (which is
   * how the BIOS and most programs pace their 50 Hz refresh), or until
   * `maxCycles` if it never does. Returns the number of cycles executed.
   */
  runFrame(maxCycles = 2 * FRAME_CYCLES) {
    const start = this.cpu.cycles;
    this.frameSync = false;
    return this.execute(maxCycles, true) - start;
  }

  setJoystick(player, x, y) {
    this.joy[player * 2] = x;
    this.joy[player * 2 + 1] = y;
  }

  /** mask bit n set = button n+1 pressed (player 1 in bits 0-3, player 2 in 4-7) */
  setButtons(mask) { this.buttons = ~mask & 0xff; }
}
