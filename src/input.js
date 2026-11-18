/**
 * Keyboard and Gamepad API input.
 *
 * The Vectrex controller has an analog joystick (read by the BIOS through
 * the DAC comparator) and four buttons wired to the PSG I/O port.
 *   Keyboard: arrows = joystick, A S D F (or 1 2 3 4) = buttons 1-4
 *   Gamepads: first pad = player 1, second pad = player 2; left stick or
 *             d-pad = joystick, face buttons = buttons 1-4
 */

const BUTTON_KEYS = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const DEADZONE = 0.15;

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pads = 0;
    target.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (ARROWS.has(e.code) || e.code in BUTTON_KEYS) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Read every input device and feed the machine. */
  poll(machine) {
    const k = this.keys;
    let x = [0, 0], y = [0, 0], buttons = 0;
    if (k.has('ArrowLeft')) x[0] -= 1;
    if (k.has('ArrowRight')) x[0] += 1;
    if (k.has('ArrowUp')) y[0] += 1;
    if (k.has('ArrowDown')) y[0] -= 1;
    for (const code of k) if (code in BUTTON_KEYS) buttons |= 1 << BUTTON_KEYS[code];

    let pads = 0;
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of list) {
      if (!pad || !pad.connected || pads >= 2) continue;
      const p = pads++;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      if (Math.abs(ax) > DEADZONE) x[p] += ax;
      if (Math.abs(ay) > DEADZONE) y[p] -= ay; // gamepad Y axis points down
      const pressed = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      if (pressed(14)) x[p] -= 1;
      if (pressed(15)) x[p] += 1;
      if (pressed(12)) y[p] += 1;
      if (pressed(13)) y[p] -= 1;
      for (let b = 0; b < 4; b++) if (pressed(b)) buttons |= 1 << (b + 4 * p);
    }
    this.pads = pads;

    const toPot = (v) => Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, v)) * 127)));
    machine.setJoystick(0, toPot(x[0]), toPot(y[0]));
    machine.setJoystick(1, toPot(x[1]), toPot(y[1]));
    machine.setButtons(buttons);
  }
}
