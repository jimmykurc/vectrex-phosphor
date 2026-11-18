import { CPU6809 } from '../src/cpu/cpu6809.js';
import { asmBytes } from '../tools/asm6809.js';

/** A flat 64 KB RAM bus. */
export class RamBus {
  constructor() { this.mem = new Uint8Array(0x10000); }
  read(a) { return this.mem[a]; }
  write(a, v) { this.mem[a] = v; }
  load(addr, bytes) { this.mem.set(bytes, addr); }
}

/**
 * Create a CPU with `code` (byte array or assembly source) at `org`.
 * The reset vector points to `org`; S = $8000.
 */
export function makeCpu(code, org = 0x1000) {
  const bus = new RamBus();
  const bytes = typeof code === 'string' ? asmBytes(code, org) : Uint8Array.from(code);
  bus.load(org, bytes);
  bus.mem[0xfffe] = org >> 8; bus.mem[0xffff] = org & 0xff;
  const cpu = new CPU6809(bus);
  cpu.reset();
  cpu.s = 0x8000;
  return { cpu, bus, end: org + bytes.length };
}

/** Step until PC reaches `end` (or a step limit). Returns cycles used. */
export function runTo(cpu, end, limit = 100000) {
  const start = cpu.cycles;
  for (let i = 0; i < limit && cpu.pc !== end; i++) cpu.step();
  if (cpu.pc !== end) throw new Error(`did not reach $${end.toString(16)} (pc=$${cpu.pc.toString(16)})`);
  return cpu.cycles - start;
}

/** Assemble, run to the end of the program, return the CPU. */
export function exec(source, setup) {
  const { cpu, bus, end } = makeCpu(source);
  if (setup) setup(cpu, bus);
  const cycles = runTo(cpu, end);
  return { cpu, bus, cycles };
}
