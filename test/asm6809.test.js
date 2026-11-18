import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asmBytes, assemble } from '../tools/asm6809.js';
import { buildDemo } from '../tools/build-demo.js';
import { DEMO_ROM } from '../src/demo/demo-rom.js';

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const a = (src, org = 0) => hex(asmBytes(src, org));

describe('assembler encodings', () => {
  test('immediate, direct, extended', () => {
    assert.equal(a('lda #$12'), '86 12');
    assert.equal(a('ldd #$1234'), 'cc 12 34');
    assert.equal(a('ldy #1'), '10 8e 00 01');
    assert.equal(a('cmps #2'), '11 8c 00 02');
    assert.equal(a('sta <$40'), '97 40');
    assert.equal(a('sta $1234'), 'b7 12 34');
    assert.equal(a(' setdp $C8\nclr $C810'), '0f 10');
  });

  test('indexed modes', () => {
    assert.equal(a('lda ,x'), 'a6 84');
    assert.equal(a('lda 5,y'), 'a6 25');
    assert.equal(a('lda -16,u'), 'a6 50');
    assert.equal(a('lda 100,s'), 'a6 e8 64');
    assert.equal(a('lda 1000,x'), 'a6 89 03 e8');
    assert.equal(a('lda ,x+'), 'a6 80');
    assert.equal(a('lda ,--y'), 'a6 a3');
    assert.equal(a('lda b,u'), 'a6 c5');
    assert.equal(a('ldd d,x'), 'ec 8b');
    assert.equal(a('lda [,x++]'), 'a6 91');
    assert.equal(a('lda [$1234]'), 'a6 9f 12 34');
    assert.equal(a('lda [2,x]'), 'a6 98 02');
    assert.equal(a('leax lbl,pcr\nlbl nop'), '30 8d 00 00 12'); // forward ref: 16-bit
    assert.equal(a('lbl nop\nleax lbl,pcr'), '12 30 8c fc'); // backward ref: 8-bit
  });

  test('branches, stack and register pairs', () => {
    assert.equal(a('here bra here'), '20 fe');
    assert.equal(a('lbeq tgt\ntgt nop'), '10 27 00 00 12');
    assert.equal(a('lbra tgt\ntgt nop'), '16 00 00 12');
    assert.equal(a('pshs a,b,x,pc'), '34 96');
    assert.equal(a('pulu cc,dp,s'), '37 49');
    assert.equal(a('tfr x,y'), '1f 12');
    assert.equal(a('exg a,b'), '1e 89');
    assert.equal(a('swi3'), '11 3f');
  });

  test('data directives, expressions, local labels', () => {
    assert.equal(a('fcb 1,-1,"AB",(3+4)*2'), '01 ff 41 42 0e');
    assert.equal(a('fdb $1234,fin\nfin'), '12 34 00 04');
    assert.equal(a("fcc \"Hi\"\nfcb 'Z'"), '48 69 5a');
    assert.equal(a('N equ 10\n fcb N<<2|1, %1010, N/3'), '29 0a 03');
    assert.equal(a('f1 bra .l\n.l nop\nf2 bra .l\n.l nop'), '20 00 12 20 00 12');
  });

  test('errors are reported with line numbers', () => {
    assert.throws(() => assemble('  lda #1\n  frob x'), /main\.asm:2: unknown mnemonic FROB/);
    assert.throws(() => assemble('  bra far\n  org $1000\nfar nop'), /branch out of range/);
  });
});

describe('demo ROM', () => {
  test('committed demo-rom.js matches demo.asm', () => {
    const { rom, tables } = buildDemo();
    assert.deepEqual([...rom], [...DEMO_ROM]);
    assert.equal(readFileSync(new URL('../demo/tables.inc', import.meta.url), 'utf8'), tables);
  });

  test('reset vector points inside the ROM', () => {
    const reset = (DEMO_ROM[0x1ffe] << 8) | DEMO_ROM[0x1fff];
    assert.ok(reset >= 0xe000);
  });
});
