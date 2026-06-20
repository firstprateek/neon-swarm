import { setTouchMove, clearTouchMove } from './input';

/**
 * On-screen touch controls: a FLOATING analog joystick (bottom-right) that drives
 * the existing getMove(), and three ability buttons (bottom-left) bound to the
 * fire closures. Multi-touch via Pointer Events + setPointerCapture so the stick
 * and an ability can be held at once. Self-contained — owns only its own DOM.
 */

export interface TouchDeps {
  fireMissile: () => void;
  fireNuke: () => void;
  doDash: () => void;
  canAct: () => boolean; // shared guard: started && !over && !leveling && !paused
}

export interface TouchControls {
  show(): void;
  hide(): void;
  setAbilityState(missiles: number, nukes: number, dashReady: boolean): void;
  el: HTMLElement; // exposed for tests
}

const R = 52;       // px max knob travel
const DEAD = 0.10;  // 10% radial dead zone

export function createTouch(deps: TouchDeps): TouchControls {
  const root = document.getElementById('touch-layer') as HTMLElement;
  const zone = document.getElementById('tc-stick-zone') as HTMLElement;
  const stick = document.getElementById('tc-stick') as HTMLElement;
  const knob = document.getElementById('tc-stick-knob') as HTMLElement;
  const bMissile = document.getElementById('tc-missile') as HTMLButtonElement;
  const bNuke = document.getElementById('tc-nuke') as HTMLButtonElement;
  const bDash = document.getElementById('tc-dash') as HTMLButtonElement;
  const ctMissile = document.getElementById('tc-missile-ct') as HTMLElement;
  const ctNuke = document.getElementById('tc-nuke-ct') as HTMLElement;

  // ---- joystick (bottom-right floating) ----
  let stickId = -1;
  let baseX = 0, baseY = 0; // current base center in client px

  const insetClampX = (x: number) => Math.min(Math.max(x, 70), innerWidth - Math.max(24, safeInset('right')));
  const insetClampY = (y: number) => Math.min(Math.max(y, 70), innerHeight - Math.max(24, safeInset('bottom')));

  function placeBase(px: number, py: number): void {
    baseX = insetClampX(px); baseY = insetClampY(py);
    stick.style.left = baseX + 'px';
    stick.style.top = baseY + 'px';
  }

  function drive(px: number, py: number): void {
    let dx = px - baseX, dy = py - baseY;
    let dist = Math.hypot(dx, dy);
    if (dist > R) {
      // dynamic re-center: slide the base so the knob pins at the rim
      baseX += dx * (1 - R / dist);
      baseY += dy * (1 - R / dist);
      stick.style.left = baseX + 'px';
      stick.style.top = baseY + 'px';
      dx = px - baseX; dy = py - baseY; dist = R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    if (dist < 1e-3) { setTouchMove(0, 0); return; }
    let mag = Math.min(dist / R, 1);
    mag = mag < DEAD ? 0 : (mag - DEAD) / (1 - DEAD); // rescale past dead zone
    setTouchMove((dx / dist) * mag, (dy / dist) * mag);
  }

  zone.addEventListener('pointerdown', e => {
    if (stickId !== -1) return;
    e.preventDefault(); e.stopPropagation();
    stickId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch { /* fast-tap race */ }
    placeBase(e.clientX, e.clientY);
    stick.classList.add('live');
    drive(e.clientX, e.clientY);
  }, { passive: false });

  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== stickId) return;
    e.preventDefault();
    drive(e.clientX, e.clientY);
  }, { passive: false });

  const endStick = (e: PointerEvent): void => {
    if (e.pointerId !== stickId) return;
    stickId = -1;
    stick.classList.remove('live');
    knob.style.transform = 'translate(0,0)';
    clearTouchMove();
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick); // iOS edge-swipe steal

  // ---- ability buttons (bottom-left) ----
  const wire = (btn: HTMLButtonElement, fn: () => void): void => {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      btn.classList.add('down');
      if (deps.canAct()) { fn(); navigator.vibrate?.(15); }
    }, { passive: false });
    const up = (): void => btn.classList.remove('down');
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  };
  wire(bMissile, deps.fireMissile);
  wire(bNuke, deps.fireNuke);
  wire(bDash, deps.doDash);

  // dirty-check cache (per-frame call; avoid layout churn like hud.ts)
  const lastState = { m: -2, n: -2, d: -2 };

  return {
    el: root,
    show(): void { root.classList.add('active'); },
    hide(): void {
      root.classList.remove('active');
      if (stickId !== -1) {
        stickId = -1;
        stick.classList.remove('live');
        knob.style.transform = 'translate(0,0)';
      }
      clearTouchMove(); // MUST clear, or a stale vector drifts the player under an overlay
    },
    setAbilityState(missiles, nukes, dashReady): void {
      if (missiles !== lastState.m) {
        lastState.m = missiles;
        ctMissile.textContent = String(missiles);
        bMissile.classList.toggle('tc-empty', missiles <= 0);
      }
      if (nukes !== lastState.n) {
        lastState.n = nukes;
        ctNuke.textContent = String(nukes);
        bNuke.classList.toggle('tc-empty', nukes <= 0);
      }
      const d = dashReady ? 1 : 0;
      if (d !== lastState.d) {
        lastState.d = d;
        bDash.classList.toggle('tc-empty', !dashReady);
      }
    },
  };
}

function safeInset(side: 'bottom' | 'right'): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--safe-${side}`);
  return parseFloat(v) || 0;
}
