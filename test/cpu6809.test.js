import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_C, FLAG_V, FLAG_Z, FLAG_N, FLAG_H, FLAG_I, FLAG_F, FLAG_E } from '../src/cpu/cpu6809.js';
import { makeCpu, runTo, exec } from './helpers.js';

const flags = (cpu) => ({
  n: !!(cpu.cc & FLAG_N), z: !!(cpu.cc & FLAG_Z), v: !!(cpu.cc & FLAG_V), c: !!(cpu.cc & FLAG_C),
});

describe('reset and fetch', () => {
  test('reset loads PC from $FFFE and masks interrupts', () => {
    const { cpu } = makeCpu([0x12], 0x4321);
    assert.equal(cpu.pc, 0x4321);
    assert.equal(cpu.cc & (FLAG_I | FLAG_F), FLAG_I | FLAG_F);
    assert.equal(cpu.dp, 0);
  });
});

describe('8-bit arithmetic flags (raw opcodes)', () => {
  test('LDA immediate sets N/Z and clears V', () => {
    let { cpu } = makeCpu([0x86, 0x80]); // LDA #$80
    cpu.cc |= FLAG_V; cpu.step();
    assert.equal(cpu.a, 0x80);
    assert.deepEqual(flags(cpu), { n: true, z: false, v: false, c: false });
    ({ cpu } = makeCpu([0x86, 0x00]));
    cpu.step();
    assert.equal(flags(cpu).z, true);
  });

  test('ADDA: signed overflow and half carry', () => {
    const { cpu } = makeCpu([0x86, 0x7f, 0x8b, 0x01]); // LDA #$7F; ADDA #1
    cpu.step(); cpu.step();
    assert.equal(cpu.a, 0x80);
    assert.deepEqual(flags(cpu), { n: true, z: false, v: true, c: false });
    assert.ok(cpu.cc & FLAG_H);
  });

  test('ADDA: carry out and zero', () => {
    const { cpu } = makeCpu([0x86, 0xff, 0x8b, 0x01]);
    cpu.step(); cpu.step();
    assert.equal(cpu.a, 0);
    assert.deepEqual(flags(cpu), { n: false, z: true, v: false, c: true });
  });

  test('ADCA adds the carry', () => {
    const { cpu } = makeCpu([0x1a, 0x01, 0x86, 0x10, 0x89, 0x05]); // ORCC #1; LDA #$10; ADCA #5
    cpu.step(); cpu.step(); cpu.step();
    assert.equal(cpu.a, 0x16);
  });

  test('SUBA borrow sets C, SBCA subtracts it', () => {
    const { cpu } = makeCpu([0x86, 0x00, 0x80, 0x01, 0x82, 0x00]); // LDA #0; SUBA #1; SBCA #0
    cpu.step(); cpu.step();
    assert.equal(cpu.a, 0xff);
    assert.deepEqual(flags(cpu), { n: true, z: false, v: false, c: true });
    cpu.step();
    assert.equal(cpu.a, 0xfe);
  });

  test('CMPA: signed overflow case $80 - $01', () => {
    const { cpu } = makeCpu([0x86, 0x80, 0x81, 0x01]);
    cpu.step(); cpu.step();
    assert.equal(cpu.a, 0x80); // unchanged
    assert.deepEqual(flags(cpu), { n: false, z: false, v: true, c: false });
  });

  test('NEG, COM, INC/DEC overflow edges', () => {
    let r = exec('lda #$80\n nega');
    assert.equal(r.cpu.a, 0x80);
    assert.equal(flags(r.cpu).v, true);
    assert.equal(flags(r.cpu).c, true);
    r = exec('lda #0\n nega');
    assert.equal(flags(r.cpu).c, false);
    r = exec('lda #$55\n coma');
    assert.equal(r.cpu.a, 0xaa);
    assert.equal(flags(r.cpu).c, true);
    r = exec('lda #$7f\n inca');
    assert.equal(r.cpu.a, 0x80);
    assert.equal(flags(r.cpu).v, true);
    r = exec('ldb #$80\n decb');
    assert.equal(r.cpu.b, 0x7f);
    assert.equal(flags(r.cpu).v, true);
  });

  test('shifts and rotates move bits through carry', () => {
    let r = exec('lda #$81\n lsra');
    assert.equal(r.cpu.a, 0x40); assert.equal(flags(r.cpu).c, true);
    r = exec('lda #$81\n asra');
    assert.equal(r.cpu.a, 0xc0); assert.equal(flags(r.cpu).n, true);
    r = exec('lda #$40\n asla');
    assert.equal(r.cpu.a, 0x80); assert.equal(flags(r.cpu).v, true); assert.equal(flags(r.cpu).c, false);
    r = exec('orcc #1\n lda #$80\n rola');
    assert.equal(r.cpu.a, 0x01); assert.equal(flags(r.cpu).c, true);
    r = exec('orcc #1\n lda #$02\n rora');
    assert.equal(r.cpu.a, 0x81); assert.equal(flags(r.cpu).c, false);
  });

  test('logical ops clear V; BIT does not store', () => {
    const r = exec('orcc #2\n lda #$F0\n anda #$3C\n bita #$0F');
    assert.equal(r.cpu.a, 0x30);
    assert.equal(flags(r.cpu).v, false);
    assert.equal(flags(r.cpu).z, true); // BIT $30 & $0F = 0
  });

  test('CLR and TST', () => {
    const r = exec('orcc #$0F\n clra');
    assert.deepEqual(flags(r.cpu), { n: false, z: true, v: false, c: false });
    const t = exec('ldb #$90\n tstb');
    assert.equal(flags(t.cpu).n, true);
  });
});

describe('16-bit operations', () => {
  test('ADDD / SUBD / CMPX flags', () => {
    let r = exec('ldd #$7FFF\n addd #1');
    assert.equal(r.cpu.d, 0x8000);
    assert.equal(flags(r.cpu).v, true);
    r = exec('ldd #$0000\n subd #1');
    assert.equal(r.cpu.d, 0xffff);
    assert.equal(flags(r.cpu).c, true);
    r = exec('ldx #$1234\n cmpx #$1234');
    assert.equal(flags(r.cpu).z, true);
  });

  test('MUL: unsigned 8x8, C = bit 7 of the result', () => {
    const r = exec('lda #200\n ldb #100\n mul');
    assert.equal(r.cpu.d, 20000);
    assert.equal(flags(r.cpu).c, false); // $4E20: bit 7 clear
    const r2 = exec('lda #$0F\n ldb #$0F\n mul');
    assert.equal(r2.cpu.d, 225);
    assert.equal(flags(r2.cpu).c, true); // $E1
  });

  test('SEX sign-extends B into A', () => {
    const r = exec('ldb #$F0\n sex');
    assert.equal(r.cpu.d, 0xfff0);
    assert.equal(flags(r.cpu).n, true);
  });

  test('DAA after BCD addition', () => {
    const r = exec('lda #$19\n adda #$28\n daa');
    assert.equal(r.cpu.a, 0x47);
    const r2 = exec('lda #$99\n adda #$01\n daa');
    assert.equal(r2.cpu.a, 0x00);
    assert.equal(flags(r2.cpu).c, true);
  });

  test('ABX adds B unsigned', () => {
    const r = exec('ldx #$1000\n ldb #$FF\n abx');
    assert.equal(r.cpu.x, 0x10ff);
  });
});

describe('addressing modes', () => {
  test('direct page uses DP as the high byte', () => {
    const r = exec('lda #$20\n tfr a,dp\n lda <$34', (cpu, bus) => { bus.mem[0x2034] = 0x5a; });
    assert.equal(r.cpu.a, 0x5a);
  });

  test('extended', () => {
    const r = exec('lda >$3456\n sta $3457', (cpu, bus) => { bus.mem[0x3456] = 0x77; });
    assert.equal(r.bus.mem[0x3457], 0x77);
  });

  test('indexed: constant offsets (5, 8, 16 bit, negative)', () => {
    const r = exec(`ldx #$2000
      lda -1,x
      ldb 100,x
      ldy #$1000
      ldu 1000,y`, (cpu, bus) => {
      bus.mem[0x1fff] = 0x11; bus.mem[0x2064] = 0x22; bus.mem[0x13e8] = 0xab; bus.mem[0x13e9] = 0xcd;
    });
    assert.equal(r.cpu.a, 0x11);
    assert.equal(r.cpu.b, 0x22);
    assert.equal(r.cpu.u, 0xabcd);
  });

  test('indexed: auto increment / decrement', () => {
    const r = exec(`ldx #$2000
      lda ,x+
      ldb ,x+
      ldy #$3000
      ldu ,--y`, (cpu, bus) => {
      bus.mem.set([1, 2], 0x2000); bus.mem.set([0xbe, 0xef], 0x2ffe);
    });
    assert.equal(r.cpu.a, 1); assert.equal(r.cpu.b, 2);
    assert.equal(r.cpu.x, 0x2002);
    assert.equal(r.cpu.y, 0x2ffe);
    assert.equal(r.cpu.u, 0xbeef);
  });

  test('indexed: accumulator offsets are signed', () => {
    const r = exec(`ldx #$2000
      lda #$FE
      ldb a,x
      ldd #$0100
      lda d,x`, (cpu, bus) => { bus.mem[0x1ffe] = 0x42; bus.mem[0x2100] = 0x24; });
    assert.equal(r.cpu.a, 0x24);
    assert.equal(r.cpu.b, 0x00); // overwritten by LDD
  });

  test('indexed: PC relative and indirect', () => {
    const r = exec(`ldx #ptr
      lda [,x]
      ldb [ptr]
      ldy data,pcr
      bra done
ptr   fdb data
data  fcb $99,$88
done  nop`);
    assert.equal(r.cpu.a, 0x99);
    assert.equal(r.cpu.b, 0x99);
    assert.equal(r.cpu.y, 0x9988);
  });

  test('LEA: LEAX sets Z, LEAS does not touch flags', () => {
    const r = exec('ldx #1\n leax -1,x');
    assert.equal(r.cpu.x, 0);
    assert.equal(flags(r.cpu).z, true);
    const r2 = exec('leas -4,s');
    assert.equal(r2.cpu.s, 0x8000 - 4);
  });
});

describe('stack, transfers, subroutines', () => {
  test('PSHS / PULS order matches the datasheet', () => {
    const { cpu, bus, end } = makeCpu(`lda #$AA
      ldb #$BB
      ldx #$1234
      pshs a,b,x
      ldd #0
      ldx #0
      puls a,b,x`);
    // stop right after the push to inspect memory
    for (let i = 0; i < 4; i++) cpu.step();
    assert.equal(cpu.s, 0x8000 - 4);
    assert.deepEqual([...bus.mem.slice(0x7ffc, 0x8000)], [0xaa, 0xbb, 0x12, 0x34]);
    runTo(cpu, end);
    assert.equal(cpu.a, 0xaa); assert.equal(cpu.b, 0xbb); assert.equal(cpu.x, 0x1234);
    assert.equal(cpu.s, 0x8000);
  });

  test('PSHU / PULU use the U stack', () => {
    const r = exec('ldu #$4000\n ldy #$5566\n pshu y\n ldy #0\n pulu y');
    assert.equal(r.cpu.y, 0x5566);
    assert.equal(r.cpu.u, 0x4000);
  });

  test('TFR and EXG between 8 and 16 bit registers', () => {
    const r = exec('ldx #$1234\n ldy #$5678\n exg x,y\n lda #$42\n tfr a,b');
    assert.equal(r.cpu.x, 0x5678); assert.equal(r.cpu.y, 0x1234);
    assert.equal(r.cpu.b, 0x42);
  });

  test('JSR / BSR / RTS and LBRA', () => {
    const r = exec(`lda #0
      bsr inc1
      jsr inc1
      lbra skip
      lda #$FF
skip  bra done
inc1  inca
      rts
done  nop`);
    assert.equal(r.cpu.a, 2);
    assert.equal(r.cpu.s, 0x8000);
  });

  test('signed and unsigned conditional branches', () => {
    const r = exec(`clrb
      lda #$80
      cmpa #$01
      blt l1        ; -128 < 1 (signed): taken
      orb #1
l1    bhi l2        ; $80 > $01 (unsigned): taken
      orb #2
l2    lda #5
      cmpa #5
      bgt l3        ; not taken
      ble l4        ; taken
l3    orb #4
l4    lbne l5       ; not taken
      lbeq l6       ; taken
l5    orb #8
l6    nop`);
    assert.equal(r.cpu.b, 0);
  });
});

describe('known programs', () => {
  test('sum of 1..100 with a 16-bit accumulator', () => {
    const r = exec(`ldd #0
      ldx #100
loop  pshs x
      addd ,s++
      leax -1,x
      bne loop
      std $2000`);
    assert.equal(r.cpu.d, 5050);
    assert.equal((r.bus.mem[0x2000] << 8) | r.bus.mem[0x2001], 5050);
  });

  test('memory copy with auto increment', () => {
    const r = exec(`ldx #$2000
      ldy #$3000
      ldb #16
cp    lda ,x+
      sta ,y+
      decb
      bne cp`, (cpu, bus) => { for (let i = 0; i < 16; i++) bus.mem[0x2000 + i] = i * 3; });
    for (let i = 0; i < 16; i++) assert.equal(r.bus.mem[0x3000 + i], i * 3);
  });

  test('Fibonacci: 24th number fits in 16 bits', () => {
    const r = exec(`ldx #0        ; f(n-1)
      ldd #1         ; f(n)
      lda #0
      ldb #1
      ldu #23
fib   pshs d
      tfr x,d
      addd ,s
      puls x
      leau -1,u
      cmpu #0
      bne fib`);
    assert.equal(r.cpu.d, 46368);
  });
});

describe('cycle counts', () => {
  const cycles = (bytes, setup) => {
    const { cpu } = makeCpu(bytes);
    if (setup) setup(cpu);
    return cpu.step();
  };
  test('inherent, immediate, direct, extended', () => {
    assert.equal(cycles([0x12]), 2); // NOP
    assert.equal(cycles([0x86, 0]), 2); // LDA #
    assert.equal(cycles([0x96, 0]), 4); // LDA <
    assert.equal(cycles([0xb6, 0, 0]), 5); // LDA >
    assert.equal(cycles([0xcc, 0, 0]), 3); // LDD #
    assert.equal(cycles([0x83, 0, 0]), 4); // SUBD #
    assert.equal(cycles([0xbd, 0x20, 0]), 8); // JSR >
    assert.equal(cycles([0x3d]), 11); // MUL
    assert.equal(cycles([0x0f, 0]), 6); // CLR <
    assert.equal(cycles([0x7e, 0x20, 0]), 4); // JMP >
    assert.equal(cycles([0x1f, 0x89]), 6); // TFR
    assert.equal(cycles([0x1e, 0x12]), 8); // EXG
  });
  test('indexed extra cycles', () => {
    assert.equal(cycles([0xa6, 0x84]), 4); // LDA ,X
    assert.equal(cycles([0xa6, 0x1f]), 5); // LDA -1,X (5-bit)
    assert.equal(cycles([0xa6, 0x80]), 6); // LDA ,X+
    assert.equal(cycles([0xa6, 0x81]), 7); // LDA ,X++
    assert.equal(cycles([0xa6, 0x89, 0, 0]), 8); // LDA n16,X
    assert.equal(cycles([0xa6, 0x8b]), 8); // LDA D,X
    assert.equal(cycles([0xa6, 0x94]), 7); // LDA [,X]
    assert.equal(cycles([0xa6, 0x9f, 0, 0]), 9); // LDA [n16]
    assert.equal(cycles([0xa6, 0x8d, 0, 0]), 9); // LDA n16,PCR
  });
  test('stack and branches', () => {
    assert.equal(cycles([0x34, 0x16]), 9); // PSHS A,B,X: 5 + 4 bytes
    assert.equal(cycles([0x34, 0xff]), 17); // PSHS all: 5 + 12
    assert.equal(cycles([0x27, 0x00]), 3); // BEQ (either way)
    assert.equal(cycles([0x10, 0x27, 0, 0]), 5); // LBEQ not taken (Z clear)
    assert.equal(cycles([0x10, 0x27, 0, 0], (c) => { c.cc |= FLAG_Z; }), 6); // LBEQ taken
    assert.equal(cycles([0x16, 0, 0]), 5); // LBRA
    assert.equal(cycles([0x17, 0, 0]), 9); // LBSR
    assert.equal(cycles([0x10, 0x83, 0, 0]), 5); // CMPD #
    assert.equal(cycles([0x11, 0xbc, 0, 0]), 8); // CMPS >
    assert.equal(cycles([0x3f]), 19); // SWI
  });
});

describe('interrupts', () => {
  test('SWI stacks the entire state and RTI restores it', () => {
    const { cpu, bus } = makeCpu(`lda #$12
      ldb #$34
      swi
      nop`);
    bus.mem[0xfffa] = 0x30; bus.mem[0xfffb] = 0x00;
    bus.mem[0x3000] = 0x3b; // RTI
    cpu.step(); cpu.step(); cpu.step();
    assert.equal(cpu.pc, 0x3000);
    assert.equal(cpu.s, 0x8000 - 12);
    assert.ok(cpu.cc & FLAG_E);
    assert.ok(cpu.cc & FLAG_I && cpu.cc & FLAG_F);
    cpu.a = 0; cpu.b = 0;
    assert.equal(cpu.step(), 15);
    assert.equal(cpu.a, 0x12); assert.equal(cpu.b, 0x34);
    assert.equal(cpu.s, 0x8000);
  });

  test('IRQ is masked by I and taken when cleared', () => {
    const { cpu, bus } = makeCpu([0x12, 0x1c, 0xef, 0x12, 0x12]); // NOP; ANDCC #$EF; NOP
    bus.mem[0xfff8] = 0x30; bus.mem[0xfff9] = 0x00;
    cpu.irq = true;
    cpu.step(); // NOP, masked
    assert.equal(cpu.pc, 0x1001);
    cpu.step(); // ANDCC clears I
    assert.equal(cpu.step(), 19); // IRQ taken
    assert.equal(cpu.pc, 0x3000);
    assert.equal(cpu.s, 0x8000 - 12);
    assert.ok(cpu.cc & FLAG_I);
  });

  test('FIRQ stacks only PC and CC', () => {
    const { cpu, bus } = makeCpu([0x1c, 0xbf, 0x12]); // ANDCC #$BF clears F
    bus.mem[0xfff6] = 0x30; bus.mem[0xfff7] = 0x00;
    cpu.step();
    cpu.firq = true;
    assert.equal(cpu.step(), 10);
    assert.equal(cpu.s, 0x8000 - 3);
    assert.equal(cpu.cc & FLAG_E, 0);
  });

  test('CWAI waits with state already stacked', () => {
    const { cpu, bus } = makeCpu([0x3c, 0xef]); // CWAI #$EF
    bus.mem[0xfff8] = 0x30; bus.mem[0xfff9] = 0x00;
    cpu.step();
    assert.equal(cpu.s, 0x8000 - 12);
    assert.equal(cpu.step(), 1); // still waiting
    cpu.irq = true;
    cpu.step();
    assert.equal(cpu.pc, 0x3000);
    assert.equal(cpu.s, 0x8000 - 12); // nothing pushed twice
  });

  test('NMI is ignored until S is loaded', () => {
    const { cpu, bus } = makeCpu([0x12, 0x10, 0xce, 0x70, 0x00, 0x12]); // NOP; LDS #$7000; NOP
    bus.mem[0xfffc] = 0x30; bus.mem[0xfffd] = 0x00;
    cpu.nmiArmed = false;
    cpu.nmi();
    cpu.step();
    assert.equal(cpu.pc, 0x1001);
    cpu.step(); // LDS arms NMI
    cpu.step();
    assert.equal(cpu.pc, 0x3000);
  });
});
