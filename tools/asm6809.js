/**
 * asm6809 - a small two-pass Motorola 6809 assembler.
 *
 * Supports the full documented instruction set and addressing modes:
 *   #imm, <direct, >extended, auto direct via SETDP, relative (short/long),
 *   indexed (n,R  ,R+  ,R++  ,-R  ,--R  A,R  B,R  D,R  n,PCR) and [indirect].
 *
 * Directives: ORG, EQU (or =), SETDP, FCB/DB, FDB/DW, FCC, RMB/DS, FILL,
 * INCLUDE, END. Labels are case-insensitive; labels starting with "." are
 * local to the previous global label. Expressions support + - * / % & | ^
 * << >> ~, parentheses, $hex, %binary, 'c' characters and * (current PC).
 *
 * Usage:
 *   const { image, symbols } = assemble(source, { include: (name) => text });
 */

const R8 = { SUB: 0x0, CMP: 0x1, SBC: 0x2, AND: 0x4, BIT: 0x5, LD: 0x6, ST: 0x7, EOR: 0x8, ADC: 0x9, OR: 0xa, ADD: 0xb };
const RMW = { NEG: 0x0, COM: 0x3, LSR: 0x4, ROR: 0x6, ASR: 0x7, ASL: 0x8, LSL: 0x8, ROL: 0x9, DEC: 0xa, INC: 0xc, TST: 0xd, CLR: 0xf };
const BRANCH = ['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE'];
const BRANCH_ALIAS = { BHS: 'BCC', BLO: 'BCS' };

/** Build the opcode table: mnemonic -> { imm, dir, idx, ext, inh, size, rel, long, ... } */
function buildTable() {
  const t = {};
  const group = (name, base, size, opts = {}) => {
    t[name] = { size, imm: opts.noImm ? undefined : base, dir: base + 0x10, idx: base + 0x20, ext: base + 0x30, prefix: opts.prefix };
  };
  for (const [op, n] of Object.entries(R8)) {
    group(op + 'A', 0x80 + n, 1, { noImm: op === 'ST' });
    group(op + 'B', 0xc0 + n, 1, { noImm: op === 'ST' });
  }
  group('SUBD', 0x83, 2); group('ADDD', 0xc3, 2); group('CMPX', 0x8c, 2);
  group('LDX', 0x8e, 2); group('STX', 0x8f, 2, { noImm: true });
  group('LDD', 0xcc, 2); group('STD', 0xcd, 2, { noImm: true });
  group('LDU', 0xce, 2); group('STU', 0xcf, 2, { noImm: true });
  group('JSR', 0x8d, 2, { noImm: true });
  group('CMPD', 0x83, 2, { prefix: 0x10 }); group('CMPY', 0x8c, 2, { prefix: 0x10 });
  group('LDY', 0x8e, 2, { prefix: 0x10 }); group('STY', 0x8f, 2, { prefix: 0x10, noImm: true });
  group('LDS', 0xce, 2, { prefix: 0x10 }); group('STS', 0xcf, 2, { prefix: 0x10, noImm: true });
  group('CMPU', 0x83, 2, { prefix: 0x11 }); group('CMPS', 0x8c, 2, { prefix: 0x11 });
  for (const [op, n] of Object.entries(RMW)) {
    t[op] = { dir: n, idx: 0x60 + n, ext: 0x70 + n };
    t[op + 'A'] = { inh: 0x40 + n };
    t[op + 'B'] = { inh: 0x50 + n };
  }
  t.JMP = { dir: 0x0e, idx: 0x6e, ext: 0x7e };
  const inh = { NOP: 0x12, SYNC: 0x13, DAA: 0x19, SEX: 0x1d, RTS: 0x39, ABX: 0x3a, RTI: 0x3b, MUL: 0x3d, SWI: 0x3f };
  for (const [k, v] of Object.entries(inh)) t[k] = { inh: v };
  t.SWI2 = { inh: 0x3f, prefix: 0x10 };
  t.SWI3 = { inh: 0x3f, prefix: 0x11 };
  t.ORCC = { imm: 0x1a, size: 1 }; t.ANDCC = { imm: 0x1c, size: 1 }; t.CWAI = { imm: 0x3c, size: 1 };
  t.LEAX = { idx: 0x30 }; t.LEAY = { idx: 0x31 }; t.LEAS = { idx: 0x32 }; t.LEAU = { idx: 0x33 };
  t.PSHS = { stack: 0x34 }; t.PULS = { stack: 0x35 }; t.PSHU = { stack: 0x36 }; t.PULU = { stack: 0x37 };
  t.TFR = { pair: 0x1f }; t.EXG = { pair: 0x1e };
  BRANCH.forEach((b, i) => {
    t[b] = { rel: 0x20 + i };
    t['L' + b] = i === 0 ? { lrel: 0x16 } : { lrel: 0x20 + i, prefix: 0x10 };
  });
  t.BSR = { rel: 0x8d }; t.LBSR = { lrel: 0x17 };
  for (const [a, b] of Object.entries(BRANCH_ALIAS)) { t[a] = t[b]; t['L' + a] = t['L' + b]; }
  return t;
}

export const OPCODES = buildTable();

const PAIR_REGS = { D: 0, X: 1, Y: 2, U: 3, S: 4, PC: 5, A: 8, B: 9, CC: 0xa, DP: 0xb };
const IDX_REGS = { X: 0, Y: 1, U: 2, S: 3 };
const STACK_BITS = { CC: 0x01, A: 0x02, B: 0x04, D: 0x06, DP: 0x08, X: 0x10, Y: 0x20, U: 0x40, S: 0x40, PC: 0x80 };

const DIRECTIVES = new Set(['ORG', 'EQU', 'SETDP', 'END', 'FCB', 'DB', '.BYTE', 'FDB', 'DW', '.WORD', 'FCC', 'RMB', 'DS', 'FILL', 'INCLUDE']);
const isKeyword = (w) => !!OPCODES[w.toUpperCase()] || DIRECTIVES.has(w.toUpperCase());

class AsmError extends Error {
  constructor(msg, line) { super(line ? `${line.file}:${line.num}: ${msg}\n    ${line.text.trim()}` : msg); }
}

/** Split on commas that are not inside quotes, brackets or parentheses. */
function splitArgs(s) {
  const out = []; let depth = 0, cur = '', quote = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "'" && i + 2 < text.length + 1) { i += 2; continue; } // 'c' character literal
    if (ch === ';') return text.slice(0, i);
  }
  return text;
}

export function assemble(source, { include, fileName = 'main.asm' } = {}) {
  // Expand INCLUDE directives into a flat list of lines
  const lines = [];
  const load = (text, file, depth) => {
    if (depth > 8) throw new AsmError('INCLUDE nesting too deep');
    text.split(/\r?\n/).forEach((raw, i) => {
      const m = /^\s*include\s+"([^"]+)"/i.exec(raw);
      if (m) {
        if (!include) throw new AsmError('INCLUDE used without an include resolver', { file, num: i + 1, text: raw });
        load(include(m[1]), m[1], depth + 1);
      } else lines.push({ file, num: i + 1, text: raw });
    });
  };
  load(source, fileName, 0);

  const symbols = new Map();
  const decisions = new Map(); // line index -> size decisions taken in pass 1
  let image, used, pc, dp, pass, globalLabel, line;

  const err = (msg) => { throw new AsmError(msg, line); };
  const symName = (name) => {
    const n = name.toUpperCase();
    return n.startsWith('.') ? globalLabel + n : n;
  };

  // ---------------------------------------------------------- expressions
  function evaluate(text) {
    let pos = 0;
    const s = text;
    const ws = () => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
    const peek = (t) => { ws(); return s.startsWith(t, pos); };
    const eat = (t) => { if (peek(t)) { pos += t.length; return true; } return false; };
    let unknown = false;
    const binary = (next, ops) => () => {
      let v = next();
      for (;;) {
        const op = ops.find((o) => peek(o));
        if (!op) return v;
        pos += op.length;
        const r = next();
        switch (op) {
          case '+': v = v + r; break; case '-': v = v - r; break;
          case '*': v = v * r; break; case '/': v = r ? Math.trunc(v / r) : 0; break;
          case '%': v = r ? v % r : 0; break; case '&': v = v & r; break;
          case '|': v = v | r; break; case '^': v = v ^ r; break;
          case '<<': v = v << r; break; case '>>': v = v >> r; break;
        }
      }
    };
    const primary = () => {
      ws();
      if (eat('(')) { const v = orExpr(); if (!eat(')')) err('missing )'); return v; }
      if (eat('-')) return -primary();
      if (eat('+')) return primary();
      if (eat('~')) return ~primary();
      const rest = s.slice(pos);
      let m;
      if ((m = /^\$([0-9a-f]+)/i.exec(rest)) || (m = /^0x([0-9a-f]+)/i.exec(rest))) { pos += m[0].length; return parseInt(m[1], 16); }
      if ((m = /^%([01]+)/.exec(rest))) { pos += m[0].length; return parseInt(m[1], 2); }
      if ((m = /^[0-9]+/.exec(rest))) { pos += m[0].length; return parseInt(m[0], 10); }
      if ((m = /^'(.)'?/.exec(rest))) { pos += m[0].length; return m[1].charCodeAt(0); }
      if (rest[0] === '*') { pos++; return pc; }
      if ((m = /^[.A-Za-z_@][\w.@]*/.exec(rest))) {
        pos += m[0].length;
        const name = symName(m[0]);
        if (symbols.has(name)) return symbols.get(name);
        if (pass === 2) err(`undefined symbol ${m[0]}`);
        unknown = true;
        return 0;
      }
      err(`bad expression "${text}"`);
    };
    const mul = binary(primary, ['*', '/', '%']);
    const add = binary(mul, ['+', '-']);
    const shift = binary(add, ['<<', '>>']);
    const and = binary(shift, ['&']);
    const xor = binary(and, ['^']);
    const orExpr = binary(xor, ['|']);
    const v = orExpr();
    ws();
    if (pos !== s.length) err(`unexpected "${s.slice(pos)}" in expression`);
    return { value: v, known: !unknown };
  }
  const value = (t) => evaluate(t).value;

  // ------------------------------------------------------------- output
  const emit = (...bytes) => {
    for (const b of bytes) {
      if (pass === 2) {
        if (pc < 0 || pc > 0xffff) err('address out of range');
        image[pc] = b & 0xff; used[pc] = 1;
      }
      pc++;
    }
  };
  const emit16 = (v) => emit((v >> 8) & 0xff, v & 0xff);

  // ------------------------------------------------------------ indexed
  function indexed(operand, li, op) {
    let indirect = false;
    let body = operand.trim();
    if (body.startsWith('[')) {
      if (!body.endsWith(']')) err('missing ]');
      indirect = true; body = body.slice(1, -1).trim();
    }
    const parts = splitArgs(body);
    const ind = indirect ? 0x10 : 0;
    if (parts.length === 1) {
      if (!indirect) err('bad indexed operand');
      const v = evaluate(parts[0]).value;
      return [0x9f, (v >> 8) & 0xff, v & 0xff]; // [n16]
    }
    if (parts.length !== 2) err('bad indexed operand');
    const [offText, regText] = parts;
    const rm = /^(-{0,2})(X|Y|U|S|PCR|PC)(\+{0,2})$/i.exec(regText.replace(/\s+/g, ''));
    if (!rm) err(`bad index register "${regText}"`);
    const [, pre, regName, post] = rm;
    const reg = regName.toUpperCase();
    if (reg === 'PC' || reg === 'PCR') {
      if (pre || post) err('auto increment not allowed with PC');
      let force = 0, t = offText;
      if (t.startsWith('<')) { force = 8; t = t.slice(1); } else if (t.startsWith('>')) { force = 16; t = t.slice(1); }
      const { value: target, known } = evaluate(t);
      let size = decisions.get(li);
      if (size === undefined) {
        size = force || (known && reg === 'PCR' && fits8(target - (pc + op + 2)) ? 8 : 16);
        if (reg === 'PC' && !force) size = known && fits8(target) ? 8 : 16;
        decisions.set(li, size);
      }
      const end = pc + op + (size === 8 ? 2 : 3);
      const off = reg === 'PCR' ? target - end : target;
      if (size === 8) { if (pass === 2 && !fits8(off)) err('PC relative offset out of range'); return [0x8c | ind, off & 0xff]; }
      return [0x8d | ind, (off >> 8) & 0xff, off & 0xff];
    }
    const rr = IDX_REGS[reg] << 5;
    if (pre || post) {
      if (offText) err('offset not allowed with auto increment');
      const code = { '+': 0x80, '++': 0x81 }[post] ?? { '-': 0x82, '--': 0x83 }[pre];
      if (pre && post) err('bad auto increment');
      if (indirect && (code === 0x80 || code === 0x82)) err('single increment not allowed with indirection');
      return [code | rr | ind];
    }
    const acc = offText.toUpperCase();
    if (acc === '') return [0x84 | rr | ind];
    if (acc === 'A') return [0x86 | rr | ind];
    if (acc === 'B') return [0x85 | rr | ind];
    if (acc === 'D') return [0x8b | rr | ind];
    let force = 0, t = offText;
    if (t.startsWith('<<')) { force = 5; t = t.slice(2); } else if (t.startsWith('<')) { force = 8; t = t.slice(1); } else if (t.startsWith('>')) { force = 16; t = t.slice(1); }
    const { value: off, known } = evaluate(t);
    let size = decisions.get(li);
    if (size === undefined) {
      if (force) size = force;
      else if (!known) size = 16;
      else if (off === 0) size = 0;
      else if (!indirect && off >= -16 && off <= 15) size = 5;
      else if (fits8(off)) size = 8;
      else size = 16;
      decisions.set(li, size);
    }
    if (size === 0 && off === 0) return [0x84 | rr | ind];
    if (size === 0) size = fits8(off) ? 8 : 16; // value changed between passes; keep it safe
    if (size === 5) { if (off < -16 || off > 15) err('5-bit offset out of range'); return [rr | (off & 0x1f)]; }
    if (size === 8) { if (pass === 2 && !fits8(off)) err('8-bit offset out of range'); return [0x88 | rr | ind, off & 0xff]; }
    return [0x89 | rr | ind, (off >> 8) & 0xff, off & 0xff];
  }

  const fits8 = (v) => v >= -128 && v <= 127;

  // --------------------------------------------------------- one line
  function instruction(mn, operand, li) {
    const def = OPCODES[mn];
    const pre = def.prefix !== undefined ? [def.prefix] : [];
    const opLen = pre.length + 1;
    if (def.inh !== undefined) { if (operand) err(`${mn} takes no operand`); return emit(...pre, def.inh); }
    if (def.rel !== undefined) {
      const target = value(operand);
      const off = target - (pc + 2);
      if (pass === 2 && !fits8(off)) err(`branch out of range (${off}), use L${mn}`);
      return emit(def.rel, off & 0xff);
    }
    if (def.lrel !== undefined) {
      const target = value(operand);
      const off = target - (pc + opLen + 2);
      return emit(...pre, def.lrel, (off >> 8) & 0xff, off & 0xff);
    }
    if (def.stack !== undefined) {
      let mask = 0;
      for (const r of splitArgs(operand)) {
        const name = r.toUpperCase();
        const bit = STACK_BITS[name];
        if (bit === undefined) err(`bad register ${r}`);
        if ((def.stack === 0x34 || def.stack === 0x35) && name === 'S') err('cannot push S on S');
        if ((def.stack === 0x36 || def.stack === 0x37) && name === 'U') err('cannot push U on U');
        mask |= bit;
      }
      return emit(def.stack, mask);
    }
    if (def.pair !== undefined) {
      const regs = splitArgs(operand).map((r) => PAIR_REGS[r.toUpperCase()]);
      if (regs.length !== 2 || regs.some((r) => r === undefined)) err('bad register pair');
      return emit(def.pair, (regs[0] << 4) | regs[1]);
    }
    if (!operand) err(`${mn} needs an operand`);
    if (operand.startsWith('#')) {
      if (def.imm === undefined) err(`${mn} has no immediate mode`);
      const v = value(operand.slice(1));
      if (def.size === 2) return emit(...pre, def.imm, (v >> 8) & 0xff, v & 0xff);
      if (pass === 2 && (v < -128 || v > 255)) err('immediate value out of range');
      return emit(...pre, def.imm, v & 0xff);
    }
    const isIndexed = operand.startsWith('[') || splitArgs(operand).length > 1;
    if (isIndexed) {
      if (def.idx === undefined) err(`${mn} has no indexed mode`);
      return emit(...pre, def.idx, ...indexed(operand, li, opLen));
    }
    let t = operand, mode = decisions.get(li);
    if (t.startsWith('<')) { mode = 'dir'; t = t.slice(1); } else if (t.startsWith('>')) { mode = 'ext'; t = t.slice(1); }
    const { value: addr, known } = evaluate(t);
    if (!mode) {
      mode = def.dir !== undefined && known && dp !== null && (addr >> 8) === dp ? 'dir' : 'ext';
      decisions.set(li, mode);
    }
    if (mode === 'dir') {
      if (def.dir === undefined) err(`${mn} has no direct mode`);
      return emit(...pre, def.dir, addr & 0xff);
    }
    if (def.ext === undefined) err(`${mn} has no extended mode`);
    return emit(...pre, def.ext, (addr >> 8) & 0xff, addr & 0xff);
  }

  function runPass(p) {
    pass = p; pc = 0; dp = null; globalLabel = '';
    image = new Uint8Array(0x10000); used = new Uint8Array(0x10000);
    for (let li = 0; li < lines.length; li++) {
      line = lines[li];
      let text = stripComment(line.text).replace(/\s+$/, '');
      if (!text.trim() || /^\s*\*/.test(text)) continue;
      let label = null;
      let m = /^([.A-Za-z_@][\w.@]*)(:?)(?=\s|$)/.exec(text);
      // A word in column 0 is a label unless it is a mnemonic/directive without a colon
      if (m && (m[2] || !isKeyword(m[1]))) { label = m[1]; text = text.slice(m[0].length); }
      else if ((m = /^\s*([.A-Za-z_@][\w.@]*):(?=\s|$)/.exec(text))) { label = m[1]; text = text.slice(m[0].length); }
      text = text.trim();
      const sp = text.search(/\s/);
      const mn = (sp < 0 ? text : text.slice(0, sp)).toUpperCase();
      const operand = sp < 0 ? '' : text.slice(sp).trim();

      if (label && (mn === 'EQU' || mn === '=')) {
        const name = symName(label);
        const v = evaluate(operand).value;
        if (pass === 1 && symbols.has(name) && symbols.get(name) !== v && !name.startsWith('.')) err(`symbol ${label} redefined`);
        symbols.set(name, v);
        continue;
      }
      if (label) {
        if (!label.startsWith('.')) globalLabel = label.toUpperCase();
        const name = symName(label);
        if (pass === 1 && symbols.has(name)) err(`duplicate label ${label}`);
        symbols.set(name, pc);
      }
      if (!mn) continue;
      switch (mn) {
        case 'ORG': pc = value(operand); continue;
        case 'SETDP': dp = value(operand) & 0xff; continue;
        case 'END': li = lines.length; continue;
        case 'FCB': case 'DB': case '.BYTE':
          for (const a of splitArgs(operand)) {
            if (/^".*"$/.test(a)) for (const ch of a.slice(1, -1)) emit(ch.charCodeAt(0));
            else emit(value(a));
          }
          continue;
        case 'FDB': case 'DW': case '.WORD':
          for (const a of splitArgs(operand)) emit16(value(a));
          continue;
        case 'FCC': {
          const q = /^(["/])(.*)\1$/.exec(operand);
          if (!q) err('FCC needs a delimited string');
          for (const ch of q[2]) emit(ch.charCodeAt(0));
          continue;
        }
        case 'RMB': case 'DS': pc += value(operand); continue;
        case 'FILL': {
          const [v, n] = splitArgs(operand).map(value);
          for (let i = 0; i < n; i++) emit(v);
          continue;
        }
      }
      if (!OPCODES[mn]) err(`unknown mnemonic ${mn}`);
      instruction(mn, operand, li);
    }
  }

  runPass(1);
  runPass(2);

  const sym = {};
  for (const [k, v] of symbols) sym[k] = v;
  return {
    symbols: sym,
    used,
    image,
    /** Extract [start, end) as a Uint8Array, filling unused bytes. */
    extract(start, end, fill = 0xff) {
      const out = new Uint8Array(end - start);
      for (let i = start; i < end; i++) out[i - start] = used[i] ? image[i] : fill;
      return out;
    },
  };
}

/** Convenience for tests: assemble at `org` and return the bytes emitted. */
export function asmBytes(source, org = 0) {
  const r = assemble(`  ORG ${org}\n${source}`);
  let end = org;
  for (let i = org; i < 0x10000; i++) if (r.used[i]) end = i + 1;
  return r.extract(org, end, 0);
}
