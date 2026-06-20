import { type KeyMap, isDown, defaultKeys } from './keybind';

const keys = new Set<string>();
let bind: KeyMap = defaultKeys(); // remappable; main.ts calls setKeyMap on load + remap

export function setKeyMap(m: KeyMap): void { bind = m; }
export function heldKeys(): Set<string> { return keys; } // for the polled FIRE read

window.addEventListener('keydown', e => {
  // prevent the FIRE key (and arrows/space) from scrolling/activating the page
  if (e.code === bind.fire || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const move = { x: 0, z: 0 };

// --- analog touch override (set by src/touch.ts) ---
let touchActive = false;
let touchX = 0, touchZ = 0;

/** Inject an analog move vector from the on-screen joystick (world axes, magnitude 0..1). */
export function setTouchMove(x: number, z: number): void {
  const len = Math.hypot(x, z);
  if (len > 1) { x /= len; z /= len; } // never exceed full speed (dynamic-recenter guard)
  touchActive = len > 0.001;
  touchX = x; touchZ = z;
}
export function clearTouchMove(): void { touchActive = false; touchX = 0; touchZ = 0; }
export function isTouchMoveActive(): boolean { return touchActive; }

export function getMove(): { x: number; z: number } {
  // analog touch wins when present — reaches movement, facing and dash direction for free
  if (touchActive) { move.x = touchX; move.z = touchZ; return move; }

  let x = 0, z = 0;
  if (isDown(bind, keys, 'moveLeft') || keys.has('ArrowLeft')) x -= 1;
  if (isDown(bind, keys, 'moveRight') || keys.has('ArrowRight')) x += 1;
  if (isDown(bind, keys, 'moveUp') || keys.has('ArrowUp')) z -= 1;
  if (isDown(bind, keys, 'moveDown') || keys.has('ArrowDown')) z += 1;
  if (x !== 0 && z !== 0) {
    const inv = 1 / Math.SQRT2;
    x *= inv; z *= inv;
  }
  move.x = x; move.z = z;
  return move;
}
