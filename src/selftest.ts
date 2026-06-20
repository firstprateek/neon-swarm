/**
 * In-browser self-test suite. Served at /test.html (dev only).
 * Imports the real game modules and asserts behavior of every system.
 * Results render to the page and land on window.__testResults for tooling.
 */
import * as THREE from 'three/webgpu';
import { SpatialGrid } from './spatial';
import { Swarm, ENEMY_TYPES, BOSS_TYPE, HIT_FLASH } from './swarm';
import { Bullets, Gems, Particles, Missiles } from './combat';
import { Blast } from './fx';
import { AmbientMotes } from './ambient';
import { TELEMETRY_ENDPOINT, LEADERBOARD_ENDPOINT, FEEDBACK_ENDPOINT, CONFIG_URL } from './config';
import { telemetryAllowed, track, __t } from './telemetry';
import { submitScore, fetchBoard, __lb } from './leaderboard';
import { normNote, dprBucket, screenTier, refAllow } from './telemetry-helpers';
import { Orbitals, Tesla } from './weapons';
import { spawnRate, rollEnemyType, bossHp, hordeSize } from './director';
import { setSeed, srand, getSeed, clearSeed } from './rng';
import { dailySeed, dailyNumber, dailyKey, secondsToNextDaily, getDailyBest, recordDailyScore } from './daily';
import { createQuality, governQuality, MAX_TIER } from './perf';
import * as sfx from './sfx';
import { defaultSettings, mergeSettings, qualityTier, applyPreset } from './settings';
import { presetFlags, flagsToPreset, coerceDifficulty } from './modes';
import { defaultKeys, mergeKeys, KEY_ACTIONS, resolveAction, isDown, keyLabel, isBindable } from './keybind';
import { AVATARS, makeSurvivor } from './avatars';
import { createState, grantXp, xpForLevel, rollUpgrades, registerKill, tickCombo, comboMultiplier, SCORE_BY_TYPE, UPGRADES } from './state';
import { getMove, setTouchMove, clearTouchMove } from './input';
import { createTouch } from './touch';
import { submitFeedback, pendingFeedback, type FeedbackCtx } from './feedback';
import * as hud from './hud';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  results.push({ name, pass: !!cond, detail: cond ? '' : detail });
}

function run(): void {
  // ---------- SpatialGrid ----------
  {
    const g = new SpatialGrid(2, 8, 16);
    const px = new Float32Array([0, 3.5, -3.5, 1e6]);
    const pz = new Float32Array([0, 3.5, -3.5, -1e6]);
    g.build(px, pz, 4, 0, 0);
    check('grid: total indexed equals count', g.cellStart[g.dim * g.dim] === 4, String(g.cellStart[g.dim * g.dim]));
    const seen = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) seen[g.indices[k]]++;
    check('grid: each point indexed exactly once (incl. clamped outliers)', seen.every(v => v === 1), JSON.stringify(seen));
  }
  {
    // fuzz: every pair closer than one cell must be discoverable via a 3x3 walk
    const N = 400, cell = 2.5, dim = 32;
    const g = new SpatialGrid(cell, dim, N);
    const px = new Float32Array(N), pz = new Float32Array(N);
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < N; i++) { px[i] = (rnd() - 0.5) * 70; pz[i] = (rnd() - 0.5) * 70; }
    g.build(px, pz, N, 0, 0);
    let missing = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = px[i] - px[j], dz = pz[i] - pz[j];
        if (dx * dx + dz * dz >= cell * cell) continue;
        let found = false;
        const cx = g.cellX(px[i]), cz = g.cellZ(pz[i]);
        for (let gz = Math.max(0, cz - 1); gz <= Math.min(dim - 1, cz + 1); gz++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(dim - 1, cx + 1); gx++) {
            const c = gz * dim + gx;
            for (let k = g.cellStart[c]; k < g.cellStart[c + 1]; k++) if (g.indices[k] === j) found = true;
          }
        }
        if (!found) missing++;
      }
    }
    check('grid: fuzz 400 pts, all close pairs discoverable', missing === 0, missing + ' pairs missing');
  }

  // ---------- Swarm ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    for (let i = 0; i < 8; i++) sw.spawn(0, i * 10, 0);
    sw.spawn(0, 999, 0);
    check('swarm: spawn beyond max ignored', sw.count === 8, String(sw.count));
    sw.kill(3);
    check('swarm: kill compacts count and mesh.count', sw.count === 7 && sw.mesh.count === 7, `${sw.count}/${sw.mesh.count}`);
    check('swarm: swap-remove moved last into freed slot', sw.posX[3] === 70, String(sw.posX[3]));
    const m = sw.mesh.instanceMatrix.array as Float32Array;
    check('swarm: instance matrix swapped with slot', m[3 * 16 + 12] === 70, String(m[3 * 16 + 12]));
    sw.hp[1] = 0; sw.hp[5] = 0; sw.hp[6] = 0;
    let deaths = 0;
    sw.sweepDead(() => deaths++);
    check('swarm: sweepDead removes all dead (incl. adjacent at end)', sw.count === 4 && deaths === 3, `count=${sw.count} deaths=${deaths}`);
    let aliveOk = true;
    for (let i = 0; i < sw.count; i++) if (sw.hp[i] <= 0) aliveOk = false;
    check('swarm: survivors all alive after sweep', aliveOk);
    while (sw.count > 0) sw.kill(0);
    check('swarm: mesh hidden when pool empties (no phantom instance)', sw.mesh.visible === false && sw.mesh.count === 0,
      `visible=${sw.mesh.visible} count=${sw.mesh.count}`);
    sw.spawn(0, 1, 1);
    check('swarm: mesh visible again on respawn', sw.mesh.visible === true && sw.mesh.count === 1);
  }
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(4, scene);
    sw.spawn(0, 10, 0);
    const g = new SpatialGrid(2.5, 16, 4);
    g.build(sw.posX, sw.posZ, sw.count, 0, 0);
    const dmg0 = sw.update(0.1, 0, 0, 0, g);
    check('swarm: enemy chases the player', sw.posX[0] < 10 && Math.abs(sw.posZ[0]) < 0.01, `x=${sw.posX[0]}`);
    check('swarm: no contact damage at range', dmg0 === 0, String(dmg0));

    const sw2 = new Swarm(4, scene);
    sw2.spawn(0, 0.5, 0);
    const g2 = new SpatialGrid(2.5, 16, 4);
    g2.build(sw2.posX, sw2.posZ, 1, 0, 0);
    const dmg = sw2.update(0.1, 0, 0, 0, g2);
    check('swarm: contact damage when touching', Math.abs(dmg - ENEMY_TYPES[0].dps * 0.1) < 1e-6, String(dmg));
  }

  // ---------- Bullets ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    sw.spawn(0, 5, 0); // grunt: hp 3, r 0.5
    const b = new Bullets(16, scene);
    b.fire(0, 0, 1, 0, 10, 3, 0);
    const g = new SpatialGrid(2.5, 32, 8);
    for (let t = 0; t < 12 && b.count > 0; t++) {
      g.build(sw.posX, sw.posZ, sw.count, 0, 0);
      b.update(0.1, sw, g);
    }
    check('bullets: travelling bullet hits and kills', sw.hp[0] <= 0, `hp=${sw.hp[0]}`);
    check('bullets: pierce-0 bullet consumed on hit', b.count === 0, String(b.count));
  }
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    sw.spawn(3, 2, 0); // elite: hp 130, r 1.6
    const b = new Bullets(16, scene);
    b.fire(0, 0, 1, 0, 1, 5, 9); // slow bullet lingers inside the same enemy
    const g = new SpatialGrid(2.5, 32, 8);
    for (let t = 0; t < 10; t++) {
      g.build(sw.posX, sw.posZ, sw.count, 0, 0);
      b.update(0.1, sw, g);
    }
    check('bullets: hit memory prevents repeat hits on same enemy', sw.hp[0] === 125, `hp=${sw.hp[0]}`);
    check('bullets: piercing bullet survives the hit', b.count === 1, String(b.count));
  }
  {
    // hit memory must survive swarm compaction (identity, not slot index)
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    sw.spawn(0, 30, 0); // slot 0: far grunt, dies mid-flight
    sw.spawn(3, 2, 0);  // slot 1: elite being pierced
    const b = new Bullets(16, scene);
    b.fire(0, 0, 1, 0, 1, 5, 9);
    const g = new SpatialGrid(2.5, 32, 8);
    g.build(sw.posX, sw.posZ, sw.count, 0, 0);
    b.update(0.1, sw, g);
    b.update(0.1, sw, g); // second step overlaps the elite -> one hit
    const hpAfterHit = sw.hp[1];
    sw.hp[0] = 0;
    sw.sweepDead(() => {}); // grunt dies, elite swaps into slot 0
    for (let t = 0; t < 8; t++) {
      g.build(sw.posX, sw.posZ, sw.count, 0, 0);
      b.update(0.1, sw, g);
    }
    check('bullets: hit memory survives swarm compaction', hpAfterHit === 125 && sw.hp[0] === 125, `afterHit=${hpAfterHit} final=${sw.hp[0]}`);
  }
  {
    // swept collision: both segment endpoints outside the hit circle
    const scene = new THREE.Scene();
    const sw = new Swarm(4, scene);
    sw.spawn(0, 3.4, 0); // grunt, hit radius 0.75
    const b = new Bullets(4, scene);
    b.fire(2.5, 0, 1, 0, 36, 1, 0); // dt 0.05 -> 1.8-unit step right across it
    const g = new SpatialGrid(2.5, 32, 4);
    g.build(sw.posX, sw.posZ, 1, 0, 0);
    b.update(0.05, sw, g);
    check('bullets: swept collision prevents tunneling at low FPS', sw.hp[0] < 3, `hp=${sw.hp[0]}`);
  }
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(2, scene); // empty swarm
    const b = new Bullets(4, scene);
    b.fire(0, 0, 1, 0, 10, 1, 0);
    const g = new SpatialGrid(2.5, 16, 2);
    g.build(sw.posX, sw.posZ, 0, 0, 0);
    for (let t = 0; t < 10; t++) b.update(0.2, sw, g);
    check('bullets: expire by lifetime with nothing to hit', b.count === 0, String(b.count));
  }

  // ---------- Gems ----------
  {
    const scene = new THREE.Scene();
    const gm = new Gems(4, scene);
    gm.spawn(3, 0, 7);
    let picked = 0;
    for (let t = 0; t < 100 && gm.count > 0; t++) gm.update(0.05, t * 0.05, 0, 0, 6, v => { picked += v; });
    check('gems: magnet pulls into pickup, value delivered', picked === 7 && gm.count === 0, `picked=${picked} count=${gm.count}`);

    const gm2 = new Gems(2, scene);
    gm2.spawn(50, 50, 1);
    gm2.spawn(60, 60, 2);
    gm2.spawn(70, 70, 4);
    const total = gm2.val[0] + gm2.val[1];
    check('gems: pool overflow folds value, none lost', gm2.count === 2 && total === 7, `count=${gm2.count} total=${total}`);

    // swap-remove must move the instance matrix with the gem
    const gm3 = new Gems(4, scene);
    gm3.spawn(5, 0, 1); // picked up (player at 5,0)
    gm3.spawn(9, 9, 2); // survivor, swaps into slot 0
    let got = 0;
    gm3.update(1 / 60, 0, 5, 0, 4, v => { got += v; });
    const m3 = gm3.mesh.instanceMatrix.array as Float32Array;
    check('gems: swapped-in gem keeps its own matrix (no 1-frame teleport)',
      got === 1 && gm3.count === 1 && Math.abs(m3[12] - 9) < 0.2 && Math.abs(m3[14] - 9) < 0.2,
      `got=${got} m=[${m3[12].toFixed(1)},${m3[14].toFixed(1)}]`);
  }

  // ---------- Particles ----------
  {
    const scene = new THREE.Scene();
    const p = new Particles(64, scene);
    p.burst(0, 1, 0, new THREE.Color(0xff0000), 1000);
    check('particles: burst clamps to pool max', p.count === 64, String(p.count));
    for (let t = 0; t < 80; t++) p.update(0.05);
    check('particles: all expire', p.count === 0, String(p.count));
    check('particles: mesh hidden when pool empties', p.mesh.visible === false);

    // bursts must be visible even on frames where update() never runs
    // (the death explosion fires after the sim stops)
    const p2 = new Particles(16, scene);
    p2.burst(7, 2, -3, new THREE.Color(0xffffff), 4);
    const pm = p2.mesh.instanceMatrix.array as Float32Array;
    let spawnMatricesOk = true;
    for (let i = 0; i < 4; i++) {
      const o = i * 16;
      if (pm[o + 12] !== 7 || pm[o + 13] !== 2 || pm[o + 14] !== -3 || pm[o] === 0) spawnMatricesOk = false;
    }
    check('particles: burst writes spawn matrices immediately', spawnMatricesOk);
  }

  // ---------- Active ability: Missiles ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    sw.spawn(2, 6, 0); // tank at +x, hp 28
    sw.spawn(0, 7.5, 1); // grunt nearby (should also catch the AoE)
    const ms = new Missiles(8, scene);
    const part = new Particles(64, scene);
    ms.fire(0, 0, 1, 0, 55, 6.5); // launch toward the cluster
    check('missiles: fire adds one and shows the mesh', ms.count === 1 && ms.mesh.visible);
    const g = new SpatialGrid(2.5, 32, 8);
    // a few frames of flight: the rocket should lay an exhaust trail (particles) before impact
    for (let t = 0; t < 4; t++) { g.build(sw.posX, sw.posZ, sw.count, 0, 0); ms.update(1 / 60, sw, g, part, () => {}); }
    check('missiles: lay an exhaust trail in flight', part.count > 0 && ms.count === 1, `trail=${part.count} missile=${ms.count}`);
    let boomed = false;
    for (let t = 0; t < 80 && ms.count > 0; t++) {
      g.build(sw.posX, sw.posZ, sw.count, 0, 0);
      ms.update(1 / 60, sw, g, part, () => { boomed = true; });
    }
    check('missiles: homes, detonates, AoE damages enemies', sw.hp[0] < 28 && sw.hp[1] < 3 && boomed && ms.count === 0, `hp0=${sw.hp[0]} hp1=${sw.hp[1]} boom=${boomed} count=${ms.count}`);

    // an enemy in seek range but OFF the +X flight axis (won't be reached in 6 frames)
    const sw2 = new Swarm(8, scene);
    sw2.spawn(0, 2, 5); // grunt up-and-right; within the rocket's grid-local seek range
    const g2 = new SpatialGrid(2.5, 64, 8);
    // dumb-fire (homing OFF): the off-axis enemy must NOT bend the rocket — it flies straight +X
    const ms2 = new Missiles(8, scene);
    ms2.fire(0, 0, 1, 0, 55, 6.5, false);
    for (let t = 0; t < 6; t++) { g2.build(sw2.posX, sw2.posZ, sw2.count, 0, 0); ms2.update(1 / 60, sw2, g2, part, () => {}); }
    check('missiles: dumb-fire flies straight (ignores off-axis enemy)', Math.abs(ms2.vz[0]) < 1e-3 && ms2.vx[0] > 0, `vx=${ms2.vx[0].toFixed(2)} vz=${ms2.vz[0].toFixed(2)}`);
    // homing ON: the same enemy bends the rocket toward it (vz grows positive)
    const ms3 = new Missiles(8, scene);
    ms3.fire(0, 0, 1, 0, 55, 6.5, true);
    for (let t = 0; t < 6 && ms3.count > 0; t++) { g2.build(sw2.posX, sw2.posZ, sw2.count, 0, 0); ms3.update(1 / 60, sw2, g2, part, () => {}); }
    check('missiles: homing seeks toward an off-axis enemy', ms3.vz[0] > 0.5, `vz=${ms3.vz[0].toFixed(2)}`);
  }

  // ---------- Nuke blast FX ----------
  {
    const scene = new THREE.Scene();
    const blast = new Blast(scene);
    check('fx: blast idle until detonated', !blast.active);
    blast.detonate(0, 0);
    check('fx: detonate activates the blast', blast.active);
    for (let t = 0; t < 5; t++) blast.update(1 / 60); // ~80ms in
    const anyVisible = scene.children.some(o => (o as THREE.Mesh).isMesh && o.visible);
    check('fx: blast renders shockwave meshes mid-detonation', anyVisible);
    for (let t = 0; t < 80; t++) blast.update(1 / 60); // run past the longest layer (~0.9s+0.18 delay)
    const allHidden = scene.children.every(o => !(o as THREE.Mesh).isMesh || !o.visible);
    check('fx: blast finishes, goes idle, hides meshes', !blast.active && allHidden);
  }

  // ---------- Ambient motes (atmosphere) ----------
  {
    const scene = new THREE.Scene();
    const am = new AmbientMotes(120, scene);
    check('ambient: builds hidden at 0 count', am.count === 0 && am.mesh.visible === false && am.max === 120);
    am.setBudget(80);
    check('ambient: setBudget activates + shows', am.count === 80 && am.mesh.count === 80 && am.mesh.visible);
    am.setBudget(999);
    check('ambient: setBudget clamps to max', am.count === 120);
    const arr = am.mesh.instanceMatrix.array as Float32Array;
    const before = Array.from(arr.slice(0, 16));
    const ver0 = am.mesh.instanceMatrix.version;
    am.update(1 / 60, 0, 0, 0.5);
    const after = Array.from(arr.slice(0, 16));
    check('ambient: update writes instance matrices + flags upload', before.join(',') !== after.join(',') && am.mesh.instanceMatrix.version > ver0);
    am.setBudget(0);
    am.update(1 / 60, 0, 0, 0.5); // must early-return without throwing
    check('ambient: 0 budget hides + no-ops', am.count === 0 && !am.mesh.visible);
  }

  // ---------- Backend SDK is OFF by default (Phase 2b feature flags) ----------
  {
    // 1. config: every endpoint null => the whole backend is a no-op
    check('backend: all endpoints null by default', TELEMETRY_ENDPOINT === null && LEADERBOARD_ENDPOINT === null && FEEDBACK_ENDPOINT === null && CONFIG_URL === null);
    check('backend: telemetry gate closed when OFF', telemetryAllowed() === false);

    // 2. zero network while OFF — stub fetch + sendBeacon; they must never be called
    try { localStorage.removeItem('ns-lb-queue'); } catch { /* ignore */ }
    let net = 0;
    const ofetch = window.fetch, obeacon = navigator.sendBeacon;
    window.fetch = (() => { net++; return Promise.reject(new Error('blocked')); }) as typeof window.fetch;
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = () => { net++; return false; };
    __t._reset();
    for (let i = 0; i < 50; i++) track('run_end', { score: i });
    const tQ = __t.queueLen();
    submitScore({ score: 100, kills: 10, level: 2, time: 30, combo_peak: 5, survivor: 'VEX', mode: 'easy', seed: 42, daily_num: 20, backend: 'webgl2' });
    const lbQ = __lb.pending().length;
    void fetchBoard(20, 'easy'); // returns null without fetching when OFF
    window.fetch = ofetch; (navigator as unknown as { sendBeacon: unknown }).sendBeacon = obeacon;
    check('backend: track() OFF queues nothing + zero network', tQ === 0 && net === 0, `q=${tQ} net=${net}`);
    check('backend: submitScore OFF queues nothing', lbQ === 0, String(lbQ));

    // 3. telemetry helpers (pure, anonymous coarsening)
    check('helpers: normNote maps the backend note', normNote(' (forced)') === 'forced' && normNote(' (auto-fallback)') === 'auto-fallback' && normNote('') === 'native');
    check('helpers: dprBucket buckets dpr', dprBucket(1) === '1' && dprBucket(2) === '2' && dprBucket(3) === '3+');
    check('helpers: screenTier tiers resolution', screenTier(1920, 1080) === '<=1080p' && screenTier(3840, 2160) === '4k');
    check('helpers: refAllow allow-lists referrers', refAllow('x.com') === 'twitter' && refAllow('discord.com') === 'discord' && refAllow('evil.example') === 'other' && refAllow(null) === null);
  }

  // ---------- Input: analog touch override ----------
  {
    setTouchMove(0.5, 0);
    const m = { ...getMove() };
    check('input: touch overrides keyboard with analog magnitude', m.x === 0.5 && m.z === 0, JSON.stringify(m));
    setTouchMove(3, 4); // length 5 -> clamps to (0.6, 0.8)
    const c = { ...getMove() };
    check('input: touch vector clamped to length 1', Math.abs(Math.hypot(c.x, c.z) - 1) < 1e-6, JSON.stringify(c));
    clearTouchMove();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const k = { ...getMove() };
    check('input: clearTouchMove restores keyboard path', k.x === 0 && k.z === -1, JSON.stringify(k));
    window.dispatchEvent(new Event('blur'));
  }

  // ---------- Touch controls (mobile-view SMOKE: ensure nothing broke) ----------
  {
    let m = 0, n = 0, d = 0;
    // 1. the layer builds without throwing (a missing #tc-fire node would crash the whole suite)
    let built = true; let tc!: ReturnType<typeof createTouch>;
    try { tc = createTouch({ fireMissile: () => m++, fireNuke: () => n++, doDash: () => d++, canAct: () => true }); }
    catch { built = false; }
    check('touch(smoke): control layer builds without throwing', built);

    // 2-4. each ability button still fires its closure once
    const tap = (id: string, pid: number) => document.getElementById(id)!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: pid, bubbles: true }));
    tap('tc-missile', 9); check('touch(smoke): missile button fires', m === 1, String(m));
    tap('tc-nuke', 10); check('touch(smoke): nuke button fires', n === 1, String(n));
    tap('tc-dash', 11); check('touch(smoke): dash button fires', d === 1, String(d));
    document.getElementById('tc-missile')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true }));

    // 5-6. joystick drag produces an analog move vector; release clears it
    clearTouchMove();
    const zone = document.getElementById('tc-stick-zone')!;
    zone.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 240, clientY: 600, bubbles: true }));
    zone.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 268, clientY: 626, bubbles: true }));
    check('touch(smoke): joystick drag moves the player', Math.hypot(getMove().x, getMove().z) > 0);
    zone.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 268, clientY: 626, bubbles: true }));
    check('touch(smoke): joystick release clears the vector', getMove().x === 0 && getMove().z === 0);

    // 7-8. show()/hide(); hide clears any stray vector
    tc.show();
    check('touch(smoke): show() activates the layer', document.getElementById('touch-layer')!.classList.contains('active'));
    setTouchMove(0.4, 0.4); tc.hide();
    check('touch(smoke): hide() clears the move vector', getMove().x === 0 && getMove().z === 0);

    // 9. empty ability state marks the buttons
    tc.setAbilityState(0, 0, false);
    check('touch(smoke): empty state marks all three buttons',
      document.getElementById('tc-missile')!.classList.contains('tc-empty') &&
      document.getElementById('tc-nuke')!.classList.contains('tc-empty') &&
      document.getElementById('tc-dash')!.classList.contains('tc-empty'));

    // 10-13. the FIRE button: only fires when visible+held; never leaks a move vector
    tc.setFireVisible(false);
    document.getElementById('tc-fire')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, bubbles: true }));
    check('touch(smoke): FIRE no-ops while hidden', tc.isFiring() === false);
    document.getElementById('tc-fire')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, bubbles: true }));
    tc.setFireVisible(true);
    clearTouchMove();
    document.getElementById('tc-fire')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 6, bubbles: true }));
    check('touch(smoke): FIRE held + visible => isFiring, no stray move', tc.isFiring() === true && getMove().x === 0 && getMove().z === 0);
    document.getElementById('tc-fire')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 6, bubbles: true }));
    check('touch(smoke): FIRE release stops firing', tc.isFiring() === false);
    document.getElementById('tc-fire')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, bubbles: true }));
    tc.hide();
    check('touch(smoke): hide() while firing stops fire', tc.isFiring() === false);

    // 14. settings reachable: the pause overlay exists with a hidden class to toggle
    check('touch(smoke): pause overlay present for the gear', !!document.getElementById('pause-overlay'));
  }

  // ---------- Feedback queue ----------
  {
    localStorage.removeItem('ns-feedback-queue');
    const ctx = {
      appVersion: '0.1.0', backend: 'webgl2', deviceClass: 'mobile', viewport: '390x844',
      dpr: 3, mode: 'free', dailyNum: null, dailyMode: null, seed: 42, survivor: 'VEX', score: 100, timeS: 30,
      level: 3, kills: 50, comboPeak: 7,
    } as FeedbackCtx;
    submitFeedback({ rating: 4, category: 'bug', text: 'x'.repeat(400) }, ctx);
    const q = pendingFeedback();
    check('feedback: submit queues one anonymous item', q.length === 1 && q[0].rating === 4 && q[0].ctx.seed === 42, String(q.length));
    check('feedback: text capped at 280, no PII fields',
      q[0].text.length === 280 && !('ua' in (q[0] as unknown as Record<string, unknown>)) && !('userAgent' in (q[0].ctx as unknown as Record<string, unknown>)));
    for (let i = 0; i < 60; i++) submitFeedback({ rating: 3, category: null, text: '' }, ctx);
    check('feedback: queue capped at 50 (drop-oldest)', pendingFeedback().length === 50, String(pendingFeedback().length));
    localStorage.removeItem('ns-feedback-queue');
  }

  // ---------- Weapons: Orbital Blades ----------
  {
    const scene = new THREE.Scene();
    const orb = new Orbitals(6, scene);
    orb.level = 0;
    const swEmpty = new Swarm(4, scene);
    const gEmpty = new SpatialGrid(2.5, 16, 4);
    gEmpty.build(swEmpty.posX, swEmpty.posZ, 0, 0, 0);
    orb.update(1 / 60, 0, 0, 0, swEmpty, gEmpty);
    check('orbitals: hidden and inert when not acquired', orb.mesh.visible === false && orb.blades === 0);

    const sw = new Swarm(16, scene);
    // ring of grunts at the blade orbit radius (2.9) so blades sweep them
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      sw.spawn(0, Math.cos(a) * 2.9, Math.sin(a) * 2.9);
    }
    orb.level = 3;
    check('orbitals: blade count scales with level', orb.blades === 4, String(orb.blades));
    const g = new SpatialGrid(2.5, 32, 16);
    let dealt = false;
    for (let t = 0; t < 120; t++) {
      g.build(sw.posX, sw.posZ, sw.count, 0, 0);
      const hpBefore = sw.hp[0];
      orb.update(1 / 60, t / 60, 0, 0, sw, g);
      if (sw.hp[0] < hpBefore) dealt = true;
    }
    check('orbitals: blades damage overlapping enemies', dealt && orb.mesh.visible && orb.mesh.count === 4);
  }

  // ---------- Weapons: Arc Tesla ----------
  {
    const scene = new THREE.Scene();
    const tes = new Tesla(64, scene);
    const particles = new Particles(256, scene);
    const sw = new Swarm(16, scene);
    // tight cluster so the bolt can chain between neighbors
    sw.spawn(2, 4, 0); sw.spawn(2, 5.5, 0); sw.spawn(2, 7, 0); sw.spawn(2, 8.5, 0);
    const g = new SpatialGrid(2.5, 32, 16);
    g.build(sw.posX, sw.posZ, sw.count, 0, 0);

    tes.level = 0;
    tes.update(1 / 60, 0, 0, sw, g, particles);
    check('tesla: inert when not acquired', sw.hp[0] === 28 && tes.mesh.visible === false);

    tes.level = 3; // chains = 4
    const before = [sw.hp[0], sw.hp[1], sw.hp[2], sw.hp[3]];
    tes.update(1 / 60, 0, 0, sw, g, particles); // cd starts at 0 -> fires this frame
    const after = [sw.hp[0], sw.hp[1], sw.hp[2], sw.hp[3]];
    const damagedCount = after.filter((h, i) => h < before[i]).length;
    check('tesla: strike chains to multiple foes', damagedCount >= 3, `damaged=${damagedCount}`);
    check('tesla: bolt segments rendered after strike', tes.mesh.visible && tes.mesh.count > 0, String(tes.mesh.count));
    const emptySw = new Swarm(1, scene);
    const emptyG = new SpatialGrid(2.5, 8, 1);
    for (let t = 0; t < 30; t++) tes.update(1 / 60, 0, 0, emptySw, emptyG, particles); // no foes -> won't refire, segments age out
    check('tesla: bolt segments fade out', tes.mesh.count === 0 && tes.mesh.visible === false, String(tes.mesh.count));
  }

  // ---------- Determinism (seeded RNG) ----------
  {
    setSeed(12345);
    const a: number[] = []; for (let i = 0; i < 16; i++) a.push(srand());
    check('rng: values in [0,1)', a.every(v => v >= 0 && v < 1));
    setSeed(12345);
    const b: number[] = []; for (let i = 0; i < 16; i++) b.push(srand());
    check('rng: same seed -> identical sequence', JSON.stringify(a) === JSON.stringify(b));
    setSeed(99);
    const c: number[] = []; for (let i = 0; i < 16; i++) c.push(srand());
    check('rng: different seed -> different sequence', JSON.stringify(a) !== JSON.stringify(c));
    check('rng: getSeed reports the active seed', getSeed() === 99);

    // gameplay rolls reproduce exactly under the same seed
    setSeed(777); const t1: number[] = []; for (let i = 0; i < 40; i++) t1.push(rollEnemyType(300));
    setSeed(777); const t2: number[] = []; for (let i = 0; i < 40; i++) t2.push(rollEnemyType(300));
    check('rng: rollEnemyType deterministic under seed', JSON.stringify(t1) === JSON.stringify(t2));
    setSeed(42); const u1 = rollUpgrades(3).map(u => u.name);
    setSeed(42); const u2 = rollUpgrades(3).map(u => u.name);
    check('rng: rollUpgrades deterministic under seed', JSON.stringify(u1) === JSON.stringify(u2) && u1.length === 3);

    // swarm spawn speeds (gameplay) reproduce; cosmetic bob/colour do not have to
    const scene = new THREE.Scene();
    setSeed(555); const sw1 = new Swarm(8, scene); for (let i = 0; i < 6; i++) sw1.spawn(0, i, 0);
    const sp1 = Array.from(sw1.speed.slice(0, 6));
    setSeed(555); const sw2 = new Swarm(8, scene); for (let i = 0; i < 6; i++) sw2.spawn(0, i, 0);
    const sp2 = Array.from(sw2.speed.slice(0, 6));
    check('rng: swarm spawn speeds deterministic under seed', JSON.stringify(sp1) === JSON.stringify(sp2));
    clearSeed(); // back to Math.random for the rest of the suite
  }

  // ---------- Daily Challenge ----------
  {
    const t = Date.UTC(2026, 5, 20, 14, 30); // 2026-06-20 14:30 UTC
    check('daily: key is UTC YYYY-MM-DD', dailyKey(t) === '2026-06-20', dailyKey(t));
    check('daily: same UTC day -> same seed', dailySeed(t) === dailySeed(Date.UTC(2026, 5, 20, 23, 59)), `${dailySeed(t)}`);
    check('daily: next UTC day -> different seed', dailySeed(t) !== dailySeed(Date.UTC(2026, 5, 21, 1, 0)));
    check('daily: seed is a uint32', (dailySeed(t) >>> 0) === dailySeed(t) && dailySeed(t) >= 0);
    check('daily: #1 is the 2026-06-01 epoch', dailyNumber(Date.UTC(2026, 5, 1, 0, 0)) === 1, String(dailyNumber(Date.UTC(2026, 5, 1))));
    check('daily: number advances one per day', dailyNumber(t) === 20, String(dailyNumber(t)));
    check('daily: countdown within a day', secondsToNextDaily(t) > 0 && secondsToNextDaily(t) <= 86400);
    // local best round-trips and only rises — PER MODE
    const k = 999001; // fixed test daily-number, far from any real one
    for (const m of ['easy', 'medium', 'hard'] as const) localStorage.removeItem(`ns-daily-best-${k}-${m}`);
    check('daily: unplayed best is 0', getDailyBest(k, 'easy') === 0);
    check('daily: first score sets a new best', recordDailyScore(k, 'easy', 500) === true && getDailyBest(k, 'easy') === 500);
    check('daily: lower score does not lower best', recordDailyScore(k, 'easy', 300) === false && getDailyBest(k, 'easy') === 500);
    check('daily: higher score raises best', recordDailyScore(k, 'easy', 900) === true && getDailyBest(k, 'easy') === 900);
    // easy / medium / hard are INDEPENDENT boards
    recordDailyScore(k, 'hard', 1200);
    check('daily: modes are independent leaderboards', getDailyBest(k, 'easy') === 900 && getDailyBest(k, 'hard') === 1200 && getDailyBest(k, 'medium') === 0);
    for (const m of ['easy', 'medium', 'hard'] as const) localStorage.removeItem(`ns-daily-best-${k}-${m}`);
  }

  // ---------- Director / difficulty ----------
  {
    check('director: spawn rate increases with time', spawnRate(120) > spawnRate(0), `${spawnRate(0)} -> ${spawnRate(120)}`);
    check('director: spawn rate soft-caps', spawnRate(100000) === 48, String(spawnRate(100000)));
    check('director: boss HP scales per boss', bossHp(2) > bossHp(1) && bossHp(3) > bossHp(2), `${bossHp(1)},${bossHp(2)},${bossHp(3)}`);
    check('director: horde size grows and clamps', hordeSize(0) >= 80 && hordeSize(100000) === 500, `${hordeSize(0)},${hordeSize(100000)}`);

    // rollEnemyType: never the boss, always a valid index, gated by time
    let everBoss = false, outOfRange = false;
    for (let i = 0; i < 500; i++) {
      const ty = rollEnemyType(Math.random() * 400, Math.random());
      if (ty === BOSS_TYPE) everBoss = true;
      if (ty < 0 || ty >= BOSS_TYPE) outOfRange = true;
    }
    check('director: ambient rolls never spawn a boss', !everBoss && !outOfRange);
    check('director: early game is grunts only', rollEnemyType(10, 0.01) === 0 && rollEnemyType(10, 0.99) === 0);
    check('director: tanks/elites gated to later', rollEnemyType(30, 0.05) <= 1 && rollEnemyType(300, 0.05) === 3,
      `${rollEnemyType(30, 0.05)},${rollEnemyType(300, 0.05)}`);
  }

  // ---------- Scoring / combo ----------
  {
    const s = createState();
    check('score: starts at zero', s.score === 0 && s.combo === 0);
    registerKill(s, 0); // grunt, combo now 1, mult 1.1
    check('score: first kill scores base*mult', s.score === Math.round(SCORE_BY_TYPE[0] * 1.1), `score=${s.score}`);
    check('score: kill builds combo', s.combo === 1 && s.comboTimer > 0);
    for (let i = 0; i < 9; i++) registerKill(s, 0); // combo now 10 -> mult 2.0
    check('score: combo multiplier grows', Math.abs(comboMultiplier(s) - 2.0) < 1e-9, String(comboMultiplier(s)));
    const before = s.score;
    registerKill(s, 4); // boss at combo 11 -> mult 2.1
    check('score: boss kill is worth a lot', s.score - before === Math.round(SCORE_BY_TYPE[4] * 2.1), `${s.score - before}`);
    // multiplier caps
    for (let i = 0; i < 60; i++) registerKill(s, 0);
    check('score: multiplier caps at 5.0', comboMultiplier(s) === 5.0, String(comboMultiplier(s)));
    // combo decays and resets
    tickCombo(s, 1.0);
    check('score: combo persists within the window', s.combo > 0);
    tickCombo(s, 5.0);
    check('score: combo resets after the window lapses', s.combo === 0 && s.comboTimer === 0);
  }

  // ---------- Hit-flash ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(4, scene);
    sw.spawn(0, 5, 0);
    const col = sw.mesh.instanceColor!.array as Float32Array;
    // pick the dimmest channel (whatever the enemy palette is) — it brightens the
    // most toward white during a flash, so it's the clearest signal
    let dim = 0;
    if (sw.baseCol[1] < sw.baseCol[dim]) dim = 1;
    if (sw.baseCol[2] < sw.baseCol[dim]) dim = 2;
    const baseD = sw.baseCol[dim];
    check('flash: base color captured at spawn', baseD === col[dim] && baseD < 0.95, `baseD=${baseD}`);
    const g = new SpatialGrid(2.5, 16, 4);
    sw.flash[0] = HIT_FLASH; // simulate a hit
    g.build(sw.posX, sw.posZ, sw.count, 0, 0);
    sw.update(1 / 600, 0, 0, 0, g); // tiny dt: still mid-flash
    check('flash: enemy brightens toward white while flashing', col[dim] > baseD + 0.05, `colD=${col[dim].toFixed(2)} baseD=${baseD.toFixed(2)}`);
    // run enough frames to finish the flash
    for (let t = 0; t < 20; t++) sw.update(1 / 60, 0, 0, 0, g);
    check('flash: color restores to base after flash ends', Math.abs(col[dim] - baseD) < 1e-4, `colD=${col[dim]} baseD=${baseD}`);
  }

  // ---------- Spawn telegraph (scale-in) ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(4, scene);
    sw.spawn(0, 3, 0); // grunt, base scale 1.0
    const m = sw.mesh.instanceMatrix.array as Float32Array;
    // scale is the magnitude of the (now yaw-rotated) first matrix column
    const sclOf = () => Math.hypot(m[0], m[2]);
    check('telegraph: spawns at scale 0', sclOf() === 0, String(sclOf()));
    const g = new SpatialGrid(2.5, 16, 4);
    g.build(sw.posX, sw.posZ, sw.count, 0, 0);
    sw.update(0.05, 0, 0, 0, g); // age 0.05 of 0.25 -> ~20%
    check('telegraph: scales in (small but growing)', sclOf() > 0 && sclOf() < sw.baseScale[0], `scale=${sclOf().toFixed(3)} base=${sw.baseScale[0]}`);
    for (let t = 0; t < 10; t++) { g.build(sw.posX, sw.posZ, sw.count, 0, 0); sw.update(0.05, 0, 0, 0, g); }
    check('telegraph: reaches full scale after grow-in', Math.abs(sclOf() - sw.baseScale[0]) < 1e-4, `scale=${sclOf()} base=${sw.baseScale[0]}`);
  }

  // ---------- Floating text (boss damage numbers) ----------
  {
    const f0 = hud.activeFloaters();
    hud.floatText(100, 120, '-42', '#ff77ff');
    check('floater: floatText activates one', hud.activeFloaters() === f0 + 1, String(hud.activeFloaters()));
    for (let t = 0; t < 60; t++) hud.tick(1 / 30); // ~2s, past the 0.85s life
    check('floater: floaters expire and free up', hud.activeFloaters() === 0, String(hud.activeFloaters()));
  }

  // ---------- Perf governor ----------
  {
    const target = 1000 / 120; // 8.33ms
    const q = createQuality(target);
    check('perf: starts at best tier', q.tier === 0);

    // sustained overload should degrade all the way to the cheapest tier
    for (let i = 0; i < 800; i++) governQuality(q, 20, target, 1 / 60);
    check('perf: sustained overload degrades to max tier', q.tier === MAX_TIER, `tier=${q.tier}`);

    // comfortable headroom should restore quality to the best tier
    for (let i = 0; i < 1600; i++) governQuality(q, 3, target, 1 / 60);
    check('perf: headroom recovers to best tier', q.tier === 0, `tier=${q.tier}`);

    // pause/stall frames must be ignored, not punished
    const q2 = createQuality(target);
    const ema0 = q2.emaMs;
    const changed = governQuality(q2, 500, target, 1 / 60);
    check('perf: stall frame ignored', changed === false && q2.emaMs === ema0);

    // cooldown prevents back-to-back tier changes
    const q3 = createQuality(target);
    q3.emaMs = 20; q3.cooldown = 0;
    const c1 = governQuality(q3, 20, target, 1 / 60);
    const c2 = governQuality(q3, 20, target, 1 / 60);
    check('perf: cooldown blocks consecutive changes', c1 === true && c2 === false, `${c1},${c2}`);

    // never steps below 0 or above MAX_TIER
    const q4 = createQuality(target);
    for (let i = 0; i < 400; i++) governQuality(q4, 2, target, 1 / 60);
    check('perf: clamps at best tier (no underflow)', q4.tier === 0);
  }

  // ---------- Settings ----------
  {
    const d = defaultSettings();
    check('settings: sane defaults', d.quality === 'auto' && d.fps === 120 && d.sound === true && d.volume === 45 && d.bloom === true);
    // garbage / partial input is validated + clamped, never trusted
    check('settings: merge rejects garbage', JSON.stringify(mergeSettings(null)) === JSON.stringify(d) && JSON.stringify(mergeSettings('nope')) === JSON.stringify(d));
    const m = mergeSettings({ quality: 'banana', fps: 999, volume: 250, bloom: 'yes', sound: false });
    check('settings: invalid quality falls back', m.quality === 'auto', m.quality);
    check('settings: invalid fps falls back', m.fps === 120, String(m.fps));
    check('settings: volume clamped to 0..100', m.volume === 100, String(m.volume));
    check('settings: non-boolean bloom falls back to default', m.bloom === true);
    check('settings: valid boolean preserved', m.sound === false);
    const m2 = mergeSettings({ quality: 'low', fps: 144, volume: 30, bloom: false, sound: true });
    check('settings: valid values preserved', m2.quality === 'low' && m2.fps === 144 && m2.volume === 30 && m2.bloom === false);
    // quality -> governor tier mapping
    check('settings: qualityTier maps modes', qualityTier('auto') === -1 && qualityTier('ultra') === 0 && qualityTier('high') === 1 && qualityTier('medium') === 2 && qualityTier('low') === 3);
    // avatar validation + persistence
    check('settings: default avatar is 0', defaultSettings().avatar === 0);
    check('settings: out-of-range avatar falls back', mergeSettings({ avatar: 99 }).avatar === 0 && mergeSettings({ avatar: -1 }).avatar === 0);
    check('settings: valid avatar preserved', mergeSettings({ avatar: 2 }).avatar === 2);
    // control flags default to EASY (today's behavior, zero change for existing players)
    check('settings: control flags default EASY', d.autoFire === true && d.gunLock === true && d.missileLock === true && d.music === 35 && d.dailyMode === 'easy');
    check('settings: garbage control flags fall back to true', (() => { const g = mergeSettings({ autoFire: 'x', gunLock: 1, missileLock: null }); return g.autoFire && g.gunLock && g.missileLock; })());
    check('settings: valid control flags preserved', (() => { const g = mergeSettings({ autoFire: false, gunLock: false, missileLock: true }); return g.autoFire === false && g.gunLock === false && g.missileLock === true; })());
    check('settings: music clamps 0..100', mergeSettings({ music: 250 }).music === 100 && mergeSettings({ music: -5 }).music === 0);
    check('settings: zoom defaults to 1 and clamps to range', d.zoom === 1 && mergeSettings({ zoom: 5 }).zoom === 1.9 && mergeSettings({ zoom: 0.1 }).zoom === 0.55 && mergeSettings({ zoom: 1.3 }).zoom === 1.3);
    check('settings: merge round-trips defaults (no missing/extra field)', JSON.stringify(mergeSettings(defaultSettings())) === JSON.stringify(d));
  }

  // ---------- Modes / presets ----------
  {
    check('modes: presetFlags(easy) all auto', JSON.stringify(presetFlags('easy')) === JSON.stringify({ autoFire: true, gunLock: true, missileLock: true }));
    check('modes: medium = autofire on, aim manual', JSON.stringify(presetFlags('medium')) === JSON.stringify({ autoFire: true, gunLock: false, missileLock: false }));
    check('modes: hard = fully manual', JSON.stringify(presetFlags('hard')) === JSON.stringify({ autoFire: false, gunLock: false, missileLock: false }));
    check('modes: flagsToPreset round-trips', flagsToPreset(presetFlags('medium')) === 'medium' && flagsToPreset(presetFlags('hard')) === 'hard' && flagsToPreset(presetFlags('easy')) === 'easy');
    check('modes: hand-tuned flags => null preset', flagsToPreset({ autoFire: true, gunLock: false, missileLock: true }) === null);
    check('modes: coerceDifficulty whitelists', coerceDifficulty('junk') === 'easy' && coerceDifficulty('hard') === 'hard');
    const sp = mergeSettings(null); applyPreset(sp, 'hard');
    check('modes: applyPreset stamps flags', sp.autoFire === false && sp.gunLock === false && sp.missileLock === false);
  }

  // ---------- Keybind ----------
  {
    const dk = defaultKeys();
    check('keybind: 8 actions, no dup codes, fire=Space', KEY_ACTIONS.length === 8 && new Set(Object.values(dk)).size === 8 && dk.fire === 'Space' && dk.missile === 'KeyE');
    check('keybind: mergeKeys(null) = defaults', JSON.stringify(mergeKeys(null)) === JSON.stringify(dk));
    check('keybind: unknown action keys dropped, valid kept', mergeKeys({ fire: 'KeyF', bogus: 'KeyZ' }).fire === 'KeyF');
    check('keybind: reserved/non-bindable rejected', mergeKeys({ fire: 'Escape' }).fire === 'Space' && mergeKeys({ moveUp: 'ArrowUp' }).moveUp === 'KeyW' && mergeKeys({ nuke: '' }).nuke === 'KeyQ');
    const repaired = mergeKeys({ fire: 'KeyQ' }); // collides with nuke(KeyQ)
    check('keybind: collisions repaired (no dup)', new Set(Object.values(repaired)).size === 8);
    check('keybind: resolveAction maps codes', resolveAction(dk, 'KeyE') === 'missile' && resolveAction(dk, 'Space') === 'fire' && resolveAction(dk, 'KeyZ') === null);
    check('keybind: isDown reads held set', isDown(dk, new Set(['KeyW']), 'moveUp') === true && isDown(dk, new Set(['KeyW']), 'fire') === false);
    check('keybind: keyLabel formats', keyLabel('KeyW') === 'W' && keyLabel('Space') === 'SPACE' && keyLabel('ShiftLeft') === 'L-SHIFT');
    check('keybind: isBindable guards', isBindable('Escape') === false && isBindable('ArrowUp') === false && isBindable('KeyF') === true);
    check('keybind: mergeSettings carries a valid rebind', mergeSettings({ keybinds: { fire: 'KeyF' } }).keybinds.fire === 'KeyF');
  }

  // ---------- Avatar select ----------
  {
    let picked = -1;
    hud.showAvatarSelect(AVATARS, 1, i => { picked = i; });
    const overlay = document.getElementById('avatar-overlay')!;
    const cardEls = document.querySelectorAll('#avatar-cards .avatar-card');
    check('avatars: four survivors with distinct names', AVATARS.length === 4 && new Set(AVATARS.map(a => a.name)).size === 4);
    check('avatars: select renders a card per survivor', cardEls.length === 4, String(cardEls.length));
    check('avatars: current selection highlighted', cardEls[1].classList.contains('selected'));
    (cardEls[2] as HTMLElement).click();
    check('avatars: clicking a card picks it and closes', picked === 2 && overlay.classList.contains('hidden'));
    // makeSurvivor builds a non-empty group with geometry
    const surv = makeSurvivor(AVATARS[0]);
    check('avatars: makeSurvivor builds a body', surv.children.length >= 6);
  }

  // ---------- Audio (sfx) ----------
  {
    let threw = false;
    try {
      sfx.initAudio();
      sfx.sfxFire(); sfx.sfxKill(); sfx.sfxPickup(); sfx.sfxLevelUp();
      sfx.sfxHurt(); sfx.sfxBossWarn(); sfx.sfxBossDie(); sfx.sfxDeath();
    } catch { threw = true; }
    check('sfx: init + every sound plays without throwing', !threw);
    const before = sfx.isMuted();
    check('sfx: toggleMute flips state', sfx.toggleMute() === !before);
    sfx.setMuted(false);
    check('sfx: setMuted(false) leaves it unmuted', sfx.isMuted() === false);
    // throttled sounds must still be safe to spam
    let spamThrew = false;
    try { for (let i = 0; i < 50; i++) { sfx.sfxFire(); sfx.sfxKill(); } } catch { spamThrew = true; }
    check('sfx: spamming throttled sounds is safe', !spamThrew);
  }

  // ---------- Boss enemy ----------
  {
    const scene = new THREE.Scene();
    const sw = new Swarm(8, scene);
    const bhp = bossHp(1);
    sw.spawn(BOSS_TYPE, 5, 5, bhp);
    check('boss: spawn with HP override sets hp and maxHp', sw.hp[0] === bhp && sw.maxHp[0] === bhp, `${sw.hp[0]}/${sw.maxHp[0]}`);
    check('boss: is much tougher than an elite', bhp > ENEMY_TYPES[3].hp * 5, String(bhp));
    // maxHp survives swap-remove compaction
    sw.spawn(0, 0, 0);
    sw.kill(0); // grunt swaps into boss slot... wait boss is slot 0; kill(0) removes boss, grunt(slot1) moves to 0
    check('boss: maxHp tracked through compaction', sw.maxHp[0] === ENEMY_TYPES[0].hp, String(sw.maxHp[0]));
  }

  // ---------- State / upgrades ----------
  {
    const s = createState();
    grantXp(s, 8);
    check('state: exact xp triggers one level-up', s.level === 2 && s.pendingLevels === 1 && s.xp === 0, JSON.stringify({ l: s.level, p: s.pendingLevels, xp: s.xp }));
    const s2 = createState();
    grantXp(s2, 100);
    check('state: big xp grant cascades levels', s2.pendingLevels >= 3 && s2.xp < s2.xpNeed, JSON.stringify({ p: s2.pendingLevels, xp: s2.xp, need: s2.xpNeed }));
    let mono = true;
    for (let l = 1; l < 50; l++) if (xpForLevel(l + 1) <= xpForLevel(l)) mono = false;
    check('state: xp curve strictly increasing to lvl 50', mono);

    const dmgU = UPGRADES.find(u => u.name === 'Plasma Overcharge')!;
    const s3 = createState();
    const before = s3.dmg;
    dmgU.apply(s3);
    check('state: damage upgrade multiplies by 1.3', Math.abs(s3.dmg - before * 1.3) < 1e-9, String(s3.dmg));

    const sat = UPGRADES[0];
    const old = sat.count;
    sat.count = sat.max;
    let excluded = true;
    for (let i = 0; i < 30; i++) if (rollUpgrades(3).includes(sat)) excluded = false;
    sat.count = old;
    check('state: maxed upgrades excluded from rolls', excluded);
    const roll = rollUpgrades(3);
    check('state: rolls are distinct', new Set(roll).size === roll.length, String(roll.length));

    const saved = UPGRADES.map(u => u.count);
    UPGRADES.forEach(u => { u.count = u.max; });
    check('state: fully-maxed pool rolls empty (softlock guard input)', rollUpgrades(3).length === 0);
    UPGRADES.forEach((u, i) => { u.count = saved[i]; });
  }

  // ---------- Input ----------
  {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const mv1 = { ...getMove() };
    check('input: W maps to -z', mv1.x === 0 && mv1.z === -1, JSON.stringify(mv1));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    const mv2 = { ...getMove() };
    check('input: diagonal is normalized', Math.abs(Math.hypot(mv2.x, mv2.z) - 1) < 1e-6, JSON.stringify(mv2));
    window.dispatchEvent(new Event('blur'));
    const mv3 = { ...getMove() };
    check('input: window blur clears held keys', mv3.x === 0 && mv3.z === 0, JSON.stringify(mv3));
  }

  // ---------- HUD ----------
  {
    const s = createState();
    s.hp = 50; s.time = 65; s.kills = 3;
    hud.update(s, 1234);
    check('hud: hp bar scales with hp', (document.getElementById('hp-fill') as HTMLElement).style.transform === 'scaleX(0.5)',
      (document.getElementById('hp-fill') as HTMLElement).style.transform);
    check('hud: timer formats mm:ss', document.getElementById('timer')!.textContent === '01:05',
      document.getElementById('timer')!.textContent ?? 'null');
    check('hud: swarm count localized', document.getElementById('enemies-txt')!.textContent === (1234).toLocaleString(),
      document.getElementById('enemies-txt')!.textContent ?? 'null');

    let startedMode: string | null = null;
    hud.showStart({ challengeSeed: null, daily: { num: 7, best: 4200 }, onDaily: () => { startedMode = 'daily'; }, onFreePlay: () => { startedMode = 'free'; } });
    check('hud: daily button shows day # and best', document.getElementById('daily-sub')!.textContent!.includes('Daily #7') && document.getElementById('daily-sub')!.textContent!.includes('4,200'));
    (document.getElementById('freeplay-btn') as HTMLElement).click();
    check('hud: free-play button begins game', startedMode === 'free' && document.getElementById('start-overlay')!.classList.contains('hidden'));

    startedMode = null;
    hud.showStart({ challengeSeed: null, daily: { num: 7, best: 0 }, onDaily: () => { startedMode = 'daily'; }, onFreePlay: () => { startedMode = 'free'; } });
    (document.getElementById('daily-btn') as HTMLElement).click();
    check('hud: daily button begins daily run', startedMode === 'daily');

    startedMode = null;
    hud.showStart({ challengeSeed: 1337, daily: { num: 7, best: 0 }, onDaily: () => { startedMode = 'daily'; }, onFreePlay: () => { startedMode = 'free'; } });
    check('hud: challenge link hides daily button', document.getElementById('daily-btn')!.classList.contains('hidden') &&
      document.getElementById('freeplay-btn')!.querySelector('.mode-main')!.textContent!.includes('ACCEPT'));
    (document.getElementById('freeplay-btn') as HTMLElement).click();
    check('hud: challenge accept begins game', startedMode === 'free');

    let picked: string | null = null;
    hud.showLevelUp(rollUpgrades(3), u => { picked = u.name; });
    const cards = document.querySelectorAll('#cards .card');
    check('hud: three upgrade cards rendered', cards.length === 3, String(cards.length));
    (cards[1] as HTMLElement).click();
    check('hud: card click picks upgrade and closes', picked !== null && document.getElementById('levelup-overlay')!.classList.contains('hidden'));

    let pickedKey: string | null = null;
    hud.showLevelUp(rollUpgrades(3), u => { pickedKey = u.name; });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', repeat: true }));
    check('hud: key auto-repeat ignored (no blind pick)', pickedKey === null);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    check('hud: number-key pick works', pickedKey !== null);

    s.score = 123456; s.comboPeak = 33; s.kills = 250;
    hud.showGameOver(s, { survivor: 'RANGER', seed: 42, shareUrl: 'https://x/?seed=42' });
    check('hud: brag card shows score + peak + seed',
      document.getElementById('brag-score')!.textContent === '123,456' &&
      document.getElementById('brag-sub')!.textContent!.includes('RANGER') &&
      document.getElementById('brag-seed')!.textContent === 'SEED #42' &&
      (document.getElementById('go-stats')!.innerHTML || '').includes('KILLS'));
    check('hud: challenge-a-friend button wired', typeof document.getElementById('share-btn')!.onclick === 'function');
    check('hud: non-daily run hides daily badge + label', document.getElementById('brag-label')!.textContent === 'NEON SWARM' &&
      document.getElementById('brag-daily')!.classList.contains('hidden'));

    hud.showGameOver(s, { survivor: 'MEDIC', seed: 99, shareUrl: 'https://x/?seed=99', daily: { num: 12, mode: 'hard', best: 123456, isBest: true } });
    check('hud: daily game-over shows DAILY label + mode + NEW BEST',
      document.getElementById('brag-label')!.textContent === '☀ DAILY #12 · HARD' &&
      !document.getElementById('brag-daily')!.classList.contains('hidden') &&
      document.getElementById('brag-daily')!.classList.contains('newbest') &&
      document.getElementById('brag-daily')!.textContent!.includes('NEW DAILY BEST'));
    hud.showGameOver(s, { survivor: 'MEDIC', seed: 99, shareUrl: 'https://x/?seed=99', daily: { num: 12, mode: 'easy', best: 200000, isBest: false } });
    check('hud: daily non-best shows standing best, no blink',
      !document.getElementById('brag-daily')!.classList.contains('newbest') &&
      document.getElementById('brag-daily')!.textContent!.includes('200,000'));
    document.getElementById('gameover-overlay')!.classList.add('hidden');

    // boss bar + warning
    hud.setBoss(750, 1500);
    check('hud: boss bar shows at half on setBoss', !document.getElementById('boss-wrap')!.classList.contains('hidden') &&
      (document.getElementById('boss-fill') as HTMLElement).style.transform === 'scaleX(0.5)',
      (document.getElementById('boss-fill') as HTMLElement).style.transform);
    hud.hideBoss();
    check('hud: hideBoss hides the bar', document.getElementById('boss-wrap')!.classList.contains('hidden'));
    hud.bossWarning();
    check('hud: boss warning appears', !document.getElementById('boss-warn')!.classList.contains('hidden'));
    hud.tick(3); // longer than the 2.4s warning
    check('hud: boss warning auto-hides after timeout', document.getElementById('boss-warn')!.classList.contains('hidden'));

    hud.toast('TEST');
    check('hud: toast appears with text', !document.getElementById('toast')!.classList.contains('hidden') && document.getElementById('toast')!.textContent === 'TEST');
    hud.tick(2); // longer than the 1.6s toast
    check('hud: toast auto-hides', document.getElementById('toast')!.classList.contains('hidden'));

    let abThrew = false;
    try { hud.flash('#ffffff', 0.6); hud.setAbilities(2, 1, true); hud.setAbilities(0, 0, false); hud.tick(0.5); } catch { abThrew = true; }
    check('hud: flash + ability HUD update without throwing', !abThrew);
    check('hud: ability counts render', document.querySelector('#ab-missile b')!.textContent === '0' && document.querySelector('#ab-nuke b')!.textContent === '0');
  }
}

let crashed: string | null = null;
try {
  run();
} catch (e) {
  crashed = e instanceof Error ? (e.stack ?? e.message) : String(e);
}

const failed = results.filter(r => !r.pass);
const out = document.getElementById('out')!;
out.innerHTML =
  `<h2 class="${failed.length || crashed ? 'fail' : 'pass'}">${crashed ? 'CRASHED' : failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} — ${results.length} tests</h2>` +
  (crashed ? `<pre class="fail">${crashed}</pre>` : '') +
  results.map(r => `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? ' — ' + r.detail : ''}</div>`).join('');

(window as unknown as Record<string, unknown>).__testResults = {
  total: results.length,
  failed: failed.length,
  crashed,
  failures: failed,
};
