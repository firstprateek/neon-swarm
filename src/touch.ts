import { setTouchMove, clearTouchMove, setTouchAim, clearTouchAim } from './input';

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
  setFireVisible(on: boolean): void; // show the FIRE button (auto-fire OFF only)
  setAimMode(on: boolean): void;     // manual-aim: show the right-thumb aim stick (move moves left)
  isFiring(): boolean;               // true while the FIRE button OR the aim stick is held
  resetMove(): void;                 // drop a held move stick (viewport resize/rotation invalidates its base)
  resetAim(): void;                  // same for the aim stick
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

  // clamp to the VISIBLE viewport — visualViewport tracks the iOS keyboard/dynamic
  // toolbar while innerWidth/innerHeight lag it; read inside the call so values stay fresh
  const insetClampX = (x: number) => {
    const w = window.visualViewport?.width ?? innerWidth;
    return Math.min(Math.max(x, 70), w - Math.max(24, safeInset('right')));
  };
  const insetClampY = (y: number) => {
    const h = window.visualViewport?.height ?? innerHeight;
    return Math.min(Math.max(y, 70), h - Math.max(24, safeInset('bottom')));
  };

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
  const resetMove = (): void => {
    if (stickId !== -1) {
      releaseCapture(zone, stickId);
      stickId = -1;
      stick.classList.remove('live');
      knob.style.transform = 'translate(0,0)';
    }
    clearTouchMove(); // MUST clear, or a stale vector drifts the player under an overlay
  };

  // ---- aim joystick (manual-aim modes; bottom-RIGHT floating, also fires) ----
  const aimZone = document.getElementById('tc-aim-zone') as HTMLElement;
  const aimStick = document.getElementById('tc-aim') as HTMLElement;
  const aimKnob = document.getElementById('tc-aim-knob') as HTMLElement;
  let aimId = -1;
  let aimBaseX = 0, aimBaseY = 0;
  let aimFiring = false;     // touching the aim stick fires (covers Hard's auto-fire-off)
  const AIM_DEAD = 6;        // px before we trust a direction (no jitter at centre)

  function placeAimBase(px: number, py: number): void {
    aimBaseX = insetClampX(px); aimBaseY = insetClampY(py);
    aimStick.style.left = aimBaseX + 'px';
    aimStick.style.top = aimBaseY + 'px';
  }
  function driveAim(px: number, py: number): void {
    let dx = px - aimBaseX, dy = py - aimBaseY;
    let dist = Math.hypot(dx, dy);
    if (dist > R) { // re-center so the knob pins at the rim, like the move stick
      aimBaseX += dx * (1 - R / dist); aimBaseY += dy * (1 - R / dist);
      aimStick.style.left = aimBaseX + 'px'; aimStick.style.top = aimBaseY + 'px';
      dx = px - aimBaseX; dy = py - aimBaseY; dist = R;
    }
    aimKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    if (dist >= AIM_DEAD) setTouchAim(dx, dy); // direction only; keep last aim inside dead zone
  }
  aimZone.addEventListener('pointerdown', e => {
    if (aimId !== -1) return;
    e.preventDefault(); e.stopPropagation();
    aimId = e.pointerId;
    try { aimZone.setPointerCapture(e.pointerId); } catch { /* fast-tap race */ }
    placeAimBase(e.clientX, e.clientY);
    aimStick.classList.add('live');
    aimFiring = true;
    driveAim(e.clientX, e.clientY);
  }, { passive: false });
  aimZone.addEventListener('pointermove', e => {
    if (e.pointerId !== aimId) return;
    e.preventDefault();
    driveAim(e.clientX, e.clientY);
  }, { passive: false });
  const endAim = (e: PointerEvent): void => {
    if (e.pointerId !== aimId) return;
    aimId = -1;
    aimStick.classList.remove('live');
    aimKnob.style.transform = 'translate(0,0)';
    aimFiring = false;
    clearTouchAim();
  };
  aimZone.addEventListener('pointerup', endAim);
  aimZone.addEventListener('pointercancel', endAim);
  const resetAim = (): void => {
    if (aimId !== -1) { releaseCapture(aimZone, aimId); aimId = -1; aimStick.classList.remove('live'); aimKnob.style.transform = 'translate(0,0)'; }
    aimFiring = false;
    clearTouchAim();
  };

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

  // ---- FIRE button (held = sustained fire; only shown when auto-fire is OFF) ----
  const bFire = document.getElementById('tc-fire') as HTMLButtonElement;
  let fireVisible = false, firingHeld = false, fireId = -1;
  const fireDown = (e: PointerEvent): void => {
    e.preventDefault(); e.stopPropagation(); // never also start the joystick
    bFire.classList.add('down'); firingHeld = true; fireId = e.pointerId;
    try { bFire.setPointerCapture(e.pointerId); } catch { /* fast-tap race */ }
  };
  const fireUp = (): void => { firingHeld = false; fireId = -1; bFire.classList.remove('down'); };
  bFire.addEventListener('pointerdown', fireDown, { passive: false });
  bFire.addEventListener('pointerup', fireUp);
  bFire.addEventListener('pointercancel', fireUp);
  bFire.addEventListener('pointerleave', fireUp);
  const resetFire = (): void => {
    if (fireId !== -1) releaseCapture(bFire, fireId);
    fireUp();
  };

  // dirty-check cache (per-frame call; avoid layout churn like hud.ts)
  const lastState = { m: -2, n: -2, d: -2 };

  return {
    el: root,
    show(): void { root.classList.add('active'); },
    hide(): void {
      root.classList.remove('active');
      resetMove(); // also releases any held pointer captures — a capture that
      resetAim();  // outlives the layer would swallow the overlay's first tap
      resetFire();
    },
    setFireVisible(on: boolean): void {
      fireVisible = on;
      bFire.classList.toggle('tc-hidden', !on);
      if (!on) resetFire();
    },
    resetMove,
    resetAim,
    setAimMode(on: boolean): void {
      root.classList.toggle('aim-mode', on);
      if (!on) resetAim(); // tearing down — drop any held aim + fire state
    },
    isFiring(): boolean { return (fireVisible && firingHeld) || aimFiring; },
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

function releaseCapture(el: Element, id: number): void {
  try { el.releasePointerCapture(id); } catch { /* pointer already gone / never captured */ }
}
