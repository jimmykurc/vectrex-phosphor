import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Vectrex, FRAME_CYCLES } from '../src/vectrex.js';
import { VectorGenerator, SCREEN_W, SCREEN_H } from '../src/hw/vector.js';
import { AY38912 } from '../src/hw/ay38912.js';
import { DEMO_ROM } from '../src/demo/demo-rom.js';
import { buildDemo } from '../tools/build-demo.js';

describe('vector generator', () => {
  test('integrates (input - offset) while RAMP is low and emits a segment', () => {
    const v = new VectorGenerator();
    v.setDac(10, 0x00); // mux on, channel 0: Y = 10
    v.setDac(-20, 0x01); // mux off: X = -20
    v.setDac(127, 0x04); // channel 2: Z
    v.xsh = -20; // X input follows the DAC
    for (let i = 0; i < 100; i++) v.tick(i, true, false, true);
    v.tick(100, false, false, false);
    assert.equal(v.count, 1);
    const s = v.segments;
    assert.deepEqual([s[0], s[1], s[2], s[3], s[4]], [0, 0, -2000, 1000, 127]);
  });

  test('ZERO recentres the beam', () => {
    const v = new VectorGenerator();
    v.xsh = 50;
    for (let i = 0; i < 10; i++) v.tick(i, true, false, false);
    assert.equal(v.x, 500);
    v.tick(10, true, true, false);
    assert.equal(v.x, 0);
  });
});

describe('AY-3-8912', () => {
  test('tone frequency = clock / (16 * period)', () => {
    const psg = new AY38912({ clock: 1500000, sampleRate: 48000 });
    psg.enabled = true;
    psg.write(0, 213); psg.write(1, 0); // ~440 Hz
    psg.write(7, 0x3e); psg.write(8, 15);
    psg.advanceTo(150000); // 0.1 s
    const s = psg.drain();
    let crossings = 0;
    for (let i = 1; i < s.length; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) crossings++;
    const freq = crossings / 2 / 0.1;
    assert.ok(Math.abs(freq - 440) < 25, `measured ${freq} Hz`);
  });

  test('envelope shape 9 decays to silence and holds', () => {
    const psg = new AY38912();
    psg.write(11, 1); psg.write(12, 0); psg.write(13, 0x09);
    assert.equal(psg.envVol, 15);
    for (let i = 0; i < 2 * 20; i++) psg.tick();
    assert.equal(psg.envVol, 0);
    assert.equal(psg.envHolding, true);
  });

  test('register 14 reads the button port', () => {
    const psg = new AY38912();
    psg.portAInput = () => 0xfe;
    assert.equal(psg.read(14), 0xfe);
  });
});

describe('Vectrex machine running the built-in demo', () => {
  const boot = () => {
    const m = new Vectrex();
    m.loadSystemRom(DEMO_ROM);
    m.reset();
    return m;
  };

  test('runs without illegal opcodes and draws on screen every frame', () => {
    const m = boot();
    m.run(FRAME_CYCLES * 5);
    for (let f = 0; f < 50; f++) {
      m.vector.clear();
      m.run(FRAME_CYCLES);
      assert.ok(m.vector.count > 100, `frame ${f}: ${m.vector.count} segments`);
      const s = m.vector.segments;
      for (let i = 0; i < m.vector.count * VectorGenerator.FIELDS; i += VectorGenerator.FIELDS) {
        for (const x of [s[i], s[i + 2]]) assert.ok(Math.abs(x) < SCREEN_W / 2, `x=${x}`);
        for (const y of [s[i + 1], s[i + 3]]) assert.ok(Math.abs(y) < SCREEN_H / 2, `y=${y}`);
      }
    }
    assert.equal(m.cpu.illegal, 0);
  });

  test('keeps a steady 50 Hz refresh', () => {
    const m = boot();
    m.run(FRAME_CYCLES * 3);
    const f0 = m.ram[0];
    m.run(FRAME_CYCLES * 100);
    const frames = (m.ram[0] - f0) & 0xff;
    assert.ok(frames >= 99 && frames <= 101, `${frames} frames`);
  });

  test('controller button 1 (read through the PSG) reverses the spin', () => {
    const { symbols } = buildDemo();
    const spin = symbols.SPIN & 0x3ff;
    const m = boot();
    m.run(FRAME_CYCLES * 3);
    assert.equal(m.ram[spin], 2);
    m.setButtons(0x01);
    m.run(FRAME_CYCLES * 2);
    m.setButtons(0);
    m.run(FRAME_CYCLES * 2);
    assert.equal(m.ram[spin], 0xfe);
  });

  test('music writes reach the PSG', () => {
    const m = boot();
    m.run(FRAME_CYCLES * 30);
    assert.equal(m.psg.regs[7], 0x3c);
    assert.ok(m.psg.regs[0] > 0);
    assert.equal(m.psg.regs[8], 0x10);
  });
});
