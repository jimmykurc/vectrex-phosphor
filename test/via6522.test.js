import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VIA6522, IFR_T1, IFR_T2, IFR_SR } from '../src/hw/via6522.js';

const ticks = (via, n) => { for (let i = 0; i < n; i++) via.tick(); };

describe('VIA 6522 timer 1', () => {
  test('one-shot: flag set N+1 cycles after loading, only once', () => {
    const via = new VIA6522();
    via.write(0x4, 10); // T1C-L latch
    via.write(0x5, 0); // T1C-H: load + start
    ticks(via, 10);
    assert.equal(via.ifr & IFR_T1, 0);
    via.tick();
    assert.equal(via.ifr & IFR_T1, IFR_T1);
    via.read(0x4); // reading T1C-L clears the flag
    assert.equal(via.ifr & IFR_T1, 0);
    ticks(via, 0x10000 + 10); // counter wraps but timer is disarmed
    assert.equal(via.ifr & IFR_T1, 0);
  });

  test('PB7 goes low while T1 runs when ACR bit 7 is set (the Vectrex RAMP)', () => {
    const via = new VIA6522();
    via.write(0xb, 0x80);
    via.write(0x4, 5);
    via.write(0x5, 0);
    assert.equal(via.pb7Out, 0);
    assert.equal(via.read(0x0) & 0x80, 0);
    ticks(via, 6);
    assert.equal(via.pb7Out, 0x80);
  });

  test('free-running mode reloads from the latch and toggles PB7', () => {
    const via = new VIA6522();
    via.write(0xb, 0xc0);
    via.write(0x4, 3);
    via.write(0x5, 0);
    ticks(via, 4);
    assert.ok(via.ifr & IFR_T1);
    assert.equal(via.pb7, 0x80);
    via.write(0xd, IFR_T1); // clear by writing IFR
    ticks(via, 4);
    assert.ok(via.ifr & IFR_T1);
    assert.equal(via.pb7, 0);
  });

  test('counter reads back while counting', () => {
    const via = new VIA6522();
    via.write(0x4, 0x34);
    via.write(0x5, 0x12);
    ticks(via, 4);
    assert.equal(via.read(0x5), 0x12);
    assert.equal(via.read(0x4), 0x30);
  });
});

describe('VIA 6522 timer 2', () => {
  test('one-shot interval and flag clear on T2C-H write', () => {
    const via = new VIA6522();
    via.write(0x8, 0x30);
    via.write(0x9, 0x75); // 30000 cycles: one Vectrex frame
    ticks(via, 30000);
    assert.equal(via.ifr & IFR_T2, 0);
    via.tick();
    assert.ok(via.ifr & IFR_T2);
    via.write(0x9, 0x75);
    assert.equal(via.ifr & IFR_T2, 0);
  });

  test('reading T2C-L clears the flag', () => {
    const via = new VIA6522();
    via.write(0x8, 1);
    via.write(0x9, 0);
    ticks(via, 2);
    assert.ok(via.ifr & IFR_T2);
    via.read(0x8);
    assert.equal(via.ifr & IFR_T2, 0);
  });
});

describe('VIA 6522 interrupts', () => {
  test('IER set/clear semantics, IFR bit 7 and IRQ output', () => {
    const via = new VIA6522();
    via.write(0xe, 0x80 | IFR_T1);
    assert.equal(via.read(0xe), 0x80 | IFR_T1);
    via.write(0x4, 0);
    via.write(0x5, 0);
    via.tick();
    assert.equal(via.irq, true);
    assert.equal(via.read(0xd), 0x80 | IFR_T1);
    via.write(0xe, IFR_T1); // bit 7 clear: disable
    assert.equal(via.irq, false);
    assert.equal(via.read(0xd), IFR_T1); // flag still set, no IRQ bit
  });
});

describe('VIA 6522 shift register and control lines', () => {
  test('shift out under phi2 drives CB2 bit by bit, then flags SR', () => {
    const via = new VIA6522();
    via.write(0xb, 0x18); // mode 110
    via.write(0xa, 0b10110000);
    const bits = [];
    for (let i = 0; i < 16; i++) { via.tick(); if (i % 2 === 1) bits.push(via.cb2); }
    assert.deepEqual(bits, [1, 0, 1, 1, 0, 0, 0, 0]);
    assert.ok(via.ifr & IFR_SR);
    assert.equal(via.read(0xa), 0b10110000); // rotated back to its original value
  });

  test('$FF keeps BLANK high after shifting, $00 turns it off', () => {
    const via = new VIA6522();
    via.write(0xb, 0x98);
    via.write(0xa, 0xff);
    for (let i = 0; i < 40; i++) via.tick();
    assert.equal(via.cb2, 1);
    via.write(0xa, 0x00);
    via.tick(); via.tick();
    assert.equal(via.cb2, 0);
  });

  test('PCR manual CA2/CB2 output levels (ZERO and BLANK)', () => {
    const via = new VIA6522();
    via.write(0xc, 0xcc);
    assert.equal(via.ca2, 0);
    assert.equal(via.cb2, 0);
    via.write(0xc, 0xee);
    assert.equal(via.ca2, 1);
    assert.equal(via.cb2, 1);
  });

  test('ports combine output register and pins through DDR', () => {
    const via = new VIA6522({ readA: () => 0x0f, readB: () => 0x20 });
    via.write(0x3, 0xf0);
    via.write(0x1, 0xa5);
    assert.equal(via.read(0x1), 0xaf);
    via.write(0x2, 0x9f);
    via.write(0x0, 0x01);
    assert.equal(via.read(0x0), 0x21);
  });
});
