#!/usr/bin/env node
/**
 * Headless Chrome smoke test + screenshot: loads the page, waits, checks
 * for console errors and that the screen is lit, then saves a PNG.
 *
 *   node tools/capture.js http://localhost:8000/ docs/screenshot.png
 *        [--wait 4000] [--size 1280x900] [--clip-canvas] [--chrome PATH]
 *
 * Exits with status 1 when the page logged errors or the canvas is blank.
 */
import { writeFileSync } from 'node:fs';
import { launch, DEFAULT_CHROME } from './cdp.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const url = args[0] || 'http://localhost:8000/';
const out = args[1] || 'screenshot.png';
const wait = +opt('--wait', 4000);
const [width, height] = opt('--size', '1280x900').split('x').map(Number);

const browser = await launch({ chrome: opt('--chrome', DEFAULT_CHROME), width, height });
try {
  await browser.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, wait));
  const info = await browser.evaluate(`(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const p = window.phosphor;
    // count lit pixels on a downscaled copy of the screen
    const t = document.createElement('canvas'); t.width = 200; t.height = 248;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, 200, 248);
    const d = g.getImageData(0, 0, 200, 248).data; let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return { x: r.x, y: r.y, w: r.width, h: r.height, lit,
      title: document.title, status: document.getElementById('status')?.textContent,
      renderer: p?.renderer?.kind, cycles: p?.machine?.cpu?.cycles, error: document.body.dataset.error || null };
  })()`);
  const params = { format: 'png' };
  if (args.includes('--clip-canvas')) params.clip = { x: info.x, y: info.y, width: info.w, height: info.h, scale: 1 };
  const shot = await browser.send('Page.captureScreenshot', params);
  const png = Buffer.from(shot.data, 'base64');
  writeFileSync(out, png);
  const errors = browser.errors();
  console.log(JSON.stringify({ url, ...info, png: out, bytes: png.length, errors }, null, 2));
  process.exitCode = errors.length || info.error || info.lit < 50 ? 1 : 0;
} finally {
  browser.close();
}
