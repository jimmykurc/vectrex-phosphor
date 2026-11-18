/**
 * Tiny animated GIF89a encoder (global 256-colour palette, LZW, looping).
 *
 *   encodeGif(width, height, frames, palette, delayCs) -> Uint8Array
 *     frames:  array of Uint8Array palette indices (width * height each)
 *     palette: array of 256 [r, g, b] entries
 *     delayCs: frame delay in hundredths of a second
 */
export function encodeGif(width, height, frames, palette, delayCs = 4) {
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const ascii = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };

  ascii('GIF89a');
  u16(width); u16(height);
  out.push(0xf7, 0, 0); // global colour table, 8 bits per primary, 256 entries
  for (let i = 0; i < 256; i++) out.push(...(palette[i] || [0, 0, 0]));
  out.push(0x21, 0xff, 0x0b); ascii('NETSCAPE2.0'); out.push(0x03, 0x01, 0x00, 0x00, 0x00); // loop forever

  for (const pixels of frames) {
    out.push(0x21, 0xf9, 0x04, 0x00); u16(delayCs); out.push(0x00, 0x00); // graphic control
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0x00); // image descriptor
    out.push(8); // LZW minimum code size
    const data = lzw(pixels);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(data[i + j]);
    }
    out.push(0x00);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

function lzw(pixels) {
  const CLEAR = 256, EOI = 257;
  const bytes = [];
  let codeSize = 9, cur = 0, bits = 0;
  const emit = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(cur & 0xff); cur >>>= 8; bits -= 8; }
  };
  let dict = new Map();
  let next = 258;
  emit(CLEAR);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const code = dict.get(key);
    if (code !== undefined) { prefix = code; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(CLEAR);
      dict = new Map();
      next = 258;
      codeSize = 9;
    }
    prefix = k;
  }
  emit(prefix);
  emit(EOI);
  if (bits > 0) bytes.push(cur & 0xff);
  return bytes;
}
