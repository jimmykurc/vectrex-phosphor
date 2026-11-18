#!/usr/bin/env node
/**
 * Record an animated GIF of the emulator screen with headless Chrome.
 * The page is paused and stepped one emulated frame at a time, so the
 * animation is smooth regardless of how fast the headless renderer is.
 *
 *   node tools/capture-gif.js http://localhost:8000/ docs/demo.gif
 *        [--frames 128] [--step 2] [--warmup 150] [--width 300]
 */
import { writeFileSync } from 'node:fs';
import { launch, DEFAULT_CHROME } from './cdp.js';
import { encodeGif } from './gif.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const url = args[0] || 'http://localhost:8000/';
const out = args[1] || 'demo.gif';
const count = +opt('--frames', 128);
const step = +opt('--step', 2);
const warmup = +opt('--warmup', 150);
const W = +opt('--width', 300);
const H = Math.round((W * 41) / 33);

const browser = await launch({ chrome: opt('--chrome', DEFAULT_CHROME), width: 1100, height: 1000 });
try {
  await browser.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));
  await browser.evaluate(`phosphor.pause(); phosphor.renderer.dither = 0; phosphor.step(${warmup}); true`);
  const frames = [];
  for (let f = 0; f < count; f++) {
    const b64 = await browser.evaluate(`(() => {
      phosphor.step(${step});
      const c = phosphor.renderer.canvas;
      const t = document.createElement('canvas'); t.width = ${W}; t.height = ${H};
      const g = t.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, ${W}, ${H});
      const d = g.getImageData(0, 0, ${W}, ${H}).data;
      let s = ''; for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
      return btoa(s);
    })()`);
    frames.push(new Uint8Array(Buffer.from(b64, 'base64')));
  }
  const errors = browser.errors();
  if (errors.length) console.log('page errors:', errors);

  // Palette: the image is essentially one hue, so index by luminance and use
  // the mean colour of each luminance bucket across all frames.
  const sum = new Float64Array(256 * 3), n = new Float64Array(256);
  // 7-bit luminance with a flat black floor keeps the LZW stream small
  const lum = (r, g, b) => {
    const l = Math.min(255, Math.round(0.3 * r + 0.59 * g + 0.11 * b)) & 0xfe;
    return l < 10 ? 0 : l;
  };
  for (const px of frames) {
    for (let i = 0; i < px.length; i += 4) {
      const l = lum(px[i], px[i + 1], px[i + 2]);
      sum[l * 3] += px[i]; sum[l * 3 + 1] += px[i + 1]; sum[l * 3 + 2] += px[i + 2]; n[l]++;
    }
  }
  const palette = [];
  for (let l = 0; l < 256; l++) {
    palette.push(n[l] ? [0, 1, 2].map((c) => Math.round(sum[l * 3 + c] / n[l])) : [Math.round(l * 0.8), Math.round(l * 0.92), l]);
  }
  const indexed = frames.map((px) => {
    const idx = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) idx[j] = lum(px[i], px[i + 1], px[i + 2]);
    return idx;
  });
  const gif = encodeGif(W, H, indexed, palette, step * 2);
  writeFileSync(out, gif);
  console.log(`wrote ${out}: ${W}x${H}, ${count} frames, ${(gif.length / 1024).toFixed(0)} KB`);
} finally {
  browser.close();
}
