/**
 * Phosphor front-end: wires the machine to the renderer, audio, input and UI.
 */
import { Vectrex, CPU_HZ } from './vectrex.js';
import { createRenderer } from './render/phosphor.js';
import { AudioOut } from './audio/audio.js';
import { Input } from './input.js';
import { DEMO_ROM } from './demo/demo-rom.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const led = $('led');

function setStatus(text, level = 'ok') {
  statusEl.textContent = text;
  led.className = 'led' + (level === 'ok' ? '' : ' ' + level);
}

// Surface unexpected errors in the UI (and in a data attribute for automated checks)
window.addEventListener('error', (e) => {
  document.body.dataset.error = String(e.message);
  setStatus('Error: ' + e.message, 'err');
});

const machine = new Vectrex();
let canvas = $('screen');
const renderer = createRenderer(canvas);
canvas = renderer.canvas;
const audio = new AudioOut(machine.psg);
const input = new Input();

const state = { mode: 'demo', bios: null, cart: null, cartName: '' };

// ------------------------------------------------------------- machine modes
function bootDemo() {
  state.mode = 'demo';
  machine.loadSystemRom(DEMO_ROM);
  machine.ejectCartridge();
  machine.reset();
  renderer.clear();
  $('demo-help').hidden = false;
  setStatus('Built-in demo game · press A to play · no BIOS needed');
}

function bootBios() {
  state.mode = 'bios';
  machine.loadSystemRom(state.bios);
  if (state.cart) machine.loadCartridge(state.cart); else machine.ejectCartridge();
  machine.reset();
  renderer.clear();
  $('demo-help').hidden = true;
  setStatus(state.cart ? `Running ${state.cartName}` : 'BIOS running (no cartridge: built-in game)');
}

function isBiosImage(bytes, name) {
  if (/bios|system|exec|rom\.dat/i.test(name)) return true;
  if (bytes.length !== 8192 && bytes.length !== 4096) return false;
  const reset = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return reset >= 0xe000 && reset < 0xfff0;
}

async function loadFile(file, kind) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) { setStatus(`${file.name} is empty`, 'err'); return; }
  if (!kind) kind = isBiosImage(bytes, file.name) ? 'bios' : 'cart';
  if (kind === 'bios') {
    if (bytes.length !== 8192 && bytes.length !== 4096) {
      setStatus(`${file.name}: a Vectrex BIOS is 8192 bytes (got ${bytes.length})`, 'err');
      return;
    }
    state.bios = bytes;
    bootBios();
  } else {
    if (bytes.length > 0x8000) setStatus(`${file.name} is larger than 32 KB; bank switching is not supported`, 'warn');
    state.cart = bytes;
    state.cartName = file.name;
    if (state.bios) bootBios();
    else setStatus(`${file.name} loaded · now load a BIOS image to boot it`, 'warn');
  }
}

// ------------------------------------------------------------------ canvas
function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.round(rect.width * dpr));
  const h = Math.max(80, Math.round(rect.height * dpr));
  if (w === canvas.width && h === canvas.height && renderer.w) return;
  canvas.width = w;
  canvas.height = h;
  renderer.resize(w, h);
}
new ResizeObserver(resize).observe(canvas);
resize();

// --------------------------------------------------------------- main loop
let last = performance.now();
let budget = 0;
let frames = 0, emuFrames = 0, emuCycles = 0, fpsT = last;
const fpsEl = $('fps');

let paused = false;

/** Run one display frame of the machine and feed its beam segments to the renderer. */
function emulateFrame() {
  const used = machine.runFrame();
  emuCycles += used;
  renderer.addFrame(machine.vector.segments, machine.vector.count);
  machine.vector.clear();
  return used;
}

function loop() {
  const now = performance.now();
  const dt = Math.max(0, Math.min(100, now - last));
  last = now;
  budget += (dt / 1000) * CPU_HZ;
  input.poll(machine);

  let ran = 0;
  while (!paused && budget > 0 && ran < 3) {
    budget -= emulateFrame();
    ran++;
  }
  if (budget > 0) budget = 0; // too slow: drop time rather than spiral
  if (ran) renderer.present();
  emuFrames += ran;
  audio.push();

  frames++;
  if (now - fpsT >= 1000) {
    const secs = (now - fpsT) / 1000;
    const speed = Math.round((emuCycles / secs / CPU_HZ) * 100);
    fpsEl.textContent = `${Math.round(emuFrames / secs)} Hz · ${Math.round(frames / secs)} fps · ${speed}%`;
    frames = emuFrames = emuCycles = 0;
    fpsT = now;
    $('pads').textContent = input.pads ? ` · ${input.pads} connected` : '';
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------- UI
$('btn-bios').addEventListener('click', () => $('file-bios').click());
$('btn-cart').addEventListener('click', () => $('file-cart').click());
$('file-bios').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0], 'bios'); e.target.value = ''; });
$('file-cart').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0], 'cart'); e.target.value = ''; });
$('btn-demo').addEventListener('click', bootDemo);
$('btn-reset').addEventListener('click', () => (state.mode === 'demo' ? bootDemo() : bootBios()));

const soundBtn = $('btn-sound');
async function setSound(on) {
  try {
    if (on) await audio.enable(); else await audio.disable();
    soundBtn.textContent = on ? 'Sound: on' : 'Sound: off';
    soundBtn.setAttribute('aria-pressed', String(on));
  } catch (err) {
    setStatus('Audio unavailable: ' + err.message, 'warn');
  }
}
soundBtn.addEventListener('click', () => setSound(!audio.enabled));

$('btn-full').addEventListener('click', () => {
  const cab = $('cabinet');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (cab.requestFullscreen) cab.requestFullscreen();
});

$('persist').addEventListener('input', (e) => { renderer.persistence = +e.target.value; });
$('glow').addEventListener('input', (e) => { renderer.glow = +e.target.value; });

// Drag and drop anywhere
const drop = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('on'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('on');
  const files = [...(e.dataTransfer?.files || [])];
  // Load BIOS candidates first so a BIOS + cartridge pair dropped together boots the cartridge
  files.sort((a, b) => (a.size === 8192 ? -1 : 0) - (b.size === 8192 ? -1 : 0));
  (async () => { for (const f of files) await loadFile(f); })();
});

// Expose for debugging from the console
// Exposed for debugging and for tools/capture-gif.js (deterministic frame stepping)
window.phosphor = {
  machine, renderer, audio,
  pause() { paused = true; },
  resume() { paused = false; budget = 0; },
  step(n = 1) { for (let i = 0; i < n; i++) emulateFrame(); renderer.present(); },
};

bootDemo();
if (renderer.kind !== 'WebGL2 (half-float)') console.info('Renderer:', renderer.kind);
requestAnimationFrame(loop);
