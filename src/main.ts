import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createState, grantXp, rollUpgrades, registerKill, tickCombo, UPGRADES } from './state';
import { getMove } from './input';
import { SpatialGrid } from './spatial';
import { Swarm, ENEMY_TYPES, BOSS_TYPE } from './swarm';
import { Bullets, Gems, Particles } from './combat';
import { Orbitals, Tesla } from './weapons';
import { spawnRate, rollEnemyType, bossHp, hordeSize, BOSS_INTERVAL } from './director';
import { createQuality, governQuality, QUALITY_TIERS, MAX_TIER } from './perf';
import * as sfx from './sfx';
import * as hud from './hud';

const MAX_ENEMIES = 20000;

async function makeRenderer(forceWebGL: boolean): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false, forceWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();
  return renderer;
}

/**
 * Draw a bright probe frame and read the canvas back; true means the pixels
 * stayed fully black — i.e. this render path never reaches the screen in the
 * current environment (seen with WebGPU canvases in some headless/embedded
 * browsers). Readback failures count as "fine" so we never downgrade on
 * inconclusive evidence.
 */
async function presentsBlack(
  canvas: HTMLCanvasElement,
  scene: THREE.Scene,
  draw: () => Promise<unknown> | unknown
): Promise<boolean> {
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(0xff00ff);
  scene.fog = null;
  const sample = (): number => {
    try {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      const ctx = c.getContext('2d');
      if (!ctx) return -1;
      ctx.drawImage(canvas, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i];
      return sum;
    } catch {
      return -1;
    }
  };
  let sum = -1;
  try {
    await draw();
    sum = sample();
    if (sum === 0) {
      await new Promise(r => setTimeout(r, 150));
      await draw();
      sum = sample();
    }
  } catch {
    sum = -1;
  }
  scene.background = prevBg;
  scene.fog = prevFog;
  return sum === 0;
}

async function start() {
  const params = new URLSearchParams(location.search);
  const forceGL = params.has('webgl'); // force the WebGL2 backend
  const pinGPU = params.has('webgpu'); // trust WebGPU, skip the watchdog probe
  const noBloom = params.has('nobloom');
  const targetFps = Math.max(30, Number(params.get('fps')) || 120);
  const targetFrameMs = 1000 / targetFps;
  // ?quality=N pins a tier and disables the adaptive governor (N=0 best..3 cheapest)
  const pinnedTier = params.has('quality') ? Math.max(0, Math.min(MAX_TIER, Number(params.get('quality')) | 0)) : -1;

  let renderer = await makeRenderer(forceGL);
  const app = document.getElementById('app')!;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.02);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 26, 15);
  camera.lookAt(0, 0, 0);

  // neutral lights so instance colors read true (tinted lights wash the palette out)
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(20, 40, 10);
  scene.add(dir);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const gridHelper = new THREE.GridHelper(1200, 240, 0x1a3a4a, 0x0e1c28);
  scene.add(gridHelper);

  // --- player ---
  const player = new THREE.Group();
  const shipMat = new THREE.MeshStandardMaterial({
    color: 0x113344, emissive: 0x44ffee, emissiveIntensity: 1.6, roughness: 0.3,
  });
  const ship = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 6), shipMat);
  ship.rotation.x = Math.PI / 2;
  ship.position.y = 0.8;
  player.add(ship);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.05, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x44ffee })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.1;
  player.add(ring);
  const glow = new THREE.PointLight(0x55ffee, 220, 30, 1.8);
  glow.position.y = 3;
  player.add(glow);
  scene.add(player);

  // --- presentation watchdog: never leave the player on a black screen ---
  const onWebGPU = () => (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  let backendNote = forceGL ? ' (forced)' : '';
  if (!forceGL && !pinGPU && onWebGPU()) {
    const black = await presentsBlack(renderer.domElement, scene, () => renderer.renderAsync(scene, camera));
    if (black) {
      console.warn('[neon-swarm] WebGPU presents black frames in this environment — auto-falling back to WebGL2 (pin with ?webgpu to override).');
      renderer.dispose();
      renderer.domElement.remove();
      renderer = await makeRenderer(true);
      app.appendChild(renderer.domElement);
      backendNote = ' (auto-fallback)';
    }
  }

  // --- systems ---
  const state = createState();
  const swarm = new Swarm(MAX_ENEMIES, scene);
  const bullets = new Bullets(4096, scene);
  const gems = new Gems(4096, scene);
  const particles = new Particles(8192, scene);
  const orbitals = new Orbitals(6, scene);
  const tesla = new Tesla(64, scene);
  const grid = new SpatialGrid(2.5, 96, MAX_ENEMIES);

  // --- post-processing bloom, validated before use ---
  let post: { render: () => void } | null = null;
  if (!noBloom) {
    try {
      const postProcessing = new THREE.PostProcessing(renderer);
      const scenePass = pass(scene, camera);
      const color = scenePass.getTextureNode('output');
      // threshold 0.75: only emissive/bright-basic surfaces bloom (player,
      // bullets, gems) — lower thresholds wash the whole horde out
      postProcessing.outputNode = color.add(bloom(color, 0.55, 0.35, 0.75));
      const pp = postProcessing as unknown as { render: () => void; renderAsync?: () => Promise<void> };
      const black = await presentsBlack(renderer.domElement, scene, () => (pp.renderAsync ? pp.renderAsync() : pp.render()));
      if (black) {
        console.warn('[neon-swarm] bloom renders black on this backend — disabling post-processing.');
      } else {
        post = postProcessing;
      }
    } catch (err) {
      console.warn('[neon-swarm] bloom unavailable, rendering without post-processing:', err);
    }
  }

  // --- adaptive quality governor (holds the target frame rate) ---
  const quality = createQuality(targetFrameMs);
  if (pinnedTier >= 0) quality.tier = pinnedTier;
  let bloomEnabled = !!post;

  function applyQuality(): void {
    const tq = QUALITY_TIERS[quality.tier];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tq.pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    bloomEnabled = tq.bloom && !!post;
    const gov = pinnedTier >= 0 ? 'pinned' : `${targetFps}fps target`;
    hud.setBackend(`${onWebGPU() ? 'WebGPU' : 'WebGL2'}${backendNote} · ${gov} · quality: ${tq.label}${post ? '' : ' (no bloom)'}`);
  }
  applyQuality();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_TIERS[quality.tier].pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- game flow ---
  let started = false;
  let over = false;
  let leveling = false;
  let shake = 0; // screen-shake magnitude, decays each frame
  const addShake = (a: number) => { shake = Math.min(2.2, shake + a); };
  let hitStop = 0; // brief slow-mo (seconds of real time) for impact on big events

  if (params.has('mute')) sfx.setMuted(true);
  hud.showStart(() => { started = true; sfx.initAudio(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyM') sfx.toggleMute();
  });

  function openLevelUp(): void {
    const choices = rollUpgrades(3);
    if (choices.length === 0) {
      // every upgrade maxed — don't softlock on an empty card list
      state.pendingLevels = 0;
      leveling = false;
      return;
    }
    leveling = true;
    sfx.sfxLevelUp();
    hud.showLevelUp(choices, u => {
      u.count++;
      u.apply(state);
      state.pendingLevels--;
      hud.update(state, swarm.count);
      if (state.pendingLevels > 0) openLevelUp();
      else leveling = false;
    });
  }

  // --- spawn director ---
  let spawnAcc = 0;
  let hordeTimer = 40;
  let bossTimer = BOSS_INTERVAL;
  let bossesSpawned = 0;
  let activeBosses = 0;

  function spawnBoss(): void {
    bossesSpawned++;
    const a = Math.random() * Math.PI * 2;
    const rad = 50;
    swarm.spawn(BOSS_TYPE, player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad, bossHp(bossesSpawned));
    activeBosses++;
    hud.bossWarning();
    sfx.sfxBossWarn();
    addShake(0.7);
  }

  function director(dt: number): void {
    const t = state.time;
    // boss timer runs even at the pool cap so bosses are never starved out
    bossTimer -= dt;
    if (bossTimer <= 0) {
      bossTimer = BOSS_INTERVAL;
      if (swarm.count < MAX_ENEMIES) spawnBoss();
    }

    if (swarm.count > MAX_ENEMIES - 64) return;

    spawnAcc += dt * spawnRate(t);
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const rad = 52 + Math.random() * 18;
      swarm.spawn(rollEnemyType(t), player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
    }

    hordeTimer -= dt;
    if (hordeTimer <= 0) {
      hordeTimer = 40;
      const n = hordeSize(t);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rad = 58 + Math.random() * 8;
        swarm.spawn(rollEnemyType(t + 30), player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
      }
    }
  }

  // project a world point to screen pixels (null if behind the camera)
  const _proj = new THREE.Vector3();
  function projectToScreen(x: number, y: number, z: number): { sx: number; sy: number } | null {
    _proj.set(x, y, z).project(camera);
    if (_proj.z > 1) return null;
    return { sx: (_proj.x * 0.5 + 0.5) * window.innerWidth, sy: (-_proj.y * 0.5 + 0.5) * window.innerHeight };
  }
  let prevBossHp = -1, bossDmgAccum = 0, bossDmgTimer = 0;

  /** Track the toughest living boss for the HUD bar + floating damage numbers. */
  function updateBossBar(dt: number): void {
    if (activeBosses <= 0) { hud.hideBoss(); prevBossHp = -1; return; }
    let bestHp = -1, bestMax = 1, bx = 0, bz = 0;
    for (let i = 0; i < swarm.count; i++) {
      if (swarm.type[i] === BOSS_TYPE && swarm.hp[i] > bestHp) {
        bestHp = swarm.hp[i];
        bestMax = swarm.maxHp[i];
        bx = swarm.posX[i];
        bz = swarm.posZ[i];
      }
    }
    if (bestHp < 0) { hud.hideBoss(); prevBossHp = -1; return; }
    hud.setBoss(bestHp, bestMax);

    // accumulate damage to the lead boss; pop a floating number periodically
    if (prevBossHp >= 0) {
      const d = prevBossHp - bestHp;
      if (d > 0 && d < prevBossHp) bossDmgAccum += d; // skip spawn/death/new-boss jumps
    }
    prevBossHp = bestHp;
    bossDmgTimer -= dt;
    if (bossDmgTimer <= 0 && bossDmgAccum >= 1) {
      const sp = projectToScreen(bx, ENEMY_TYPES[BOSS_TYPE].radius + 2.5, bz);
      if (sp) hud.floatText(sp.sx, sp.sy, '-' + Math.round(bossDmgAccum), '#ff77ff');
      bossDmgAccum = 0;
      bossDmgTimer = 0.2;
    }
  }

  // --- firing ---
  let fireAcc = 0;
  let facing = 0;
  let muzzle = 0; // muzzle-flash glow pulse, decays each frame
  const baseGlow = glow.intensity;

  function fireVolley(): void {
    const px = player.position.x, pz = player.position.z;
    let dirX = Math.sin(facing), dirZ = Math.cos(facing);
    const target = swarm.nearest(px, pz);
    if (target >= 0) {
      const dx = swarm.posX[target] - px, dz = swarm.posZ[target] - pz;
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-6;
      dirX = dx / d;
      dirZ = dz / d;
    }
    const n = state.projectiles;
    const spread = 0.14;
    const base = Math.atan2(dirX, dirZ) - ((n - 1) / 2) * spread;
    for (let k = 0; k < n; k++) {
      const a = base + k * spread;
      bullets.fire(px, pz, Math.sin(a), Math.cos(a), state.bulletSpeed, state.dmg, state.pierce);
    }
    muzzle = 1;
    sfx.sfxFire(); // throttled internally
  }

  function gameOver(): void {
    over = true;
    particles.burst(player.position.x, 1, player.position.z, new THREE.Color(0x44ffee), 160, 16);
    player.visible = false;
    addShake(2.0);
    sfx.sfxDeath();
    hud.hideBoss();
    hud.showGameOver(state);
  }

  // debug/benchmark hook: spawn a ring of n enemies around the player
  // (grants effectively infinite HP — it's a stress test, not a fair fight)
  (window as unknown as Record<string, unknown>).__spawnTest = (n: number) => {
    state.maxHp = state.hp = 1e9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 15 + Math.random() * 45;
      // ambient types only (0..BOSS_TYPE-1) — bosses come from spawnBoss so
      // the activeBosses counter and boss bar stay consistent
      swarm.spawn((Math.random() * BOSS_TYPE) | 0, player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
    }
    return swarm.count;
  };

  // structured debug handle for E2E tests and console poking;
  // step() drives the real update/render path with a fixed dt so tests
  // stay deterministic even where rAF is throttled (hidden/headless tabs)
  (window as unknown as Record<string, unknown>).__dbg = {
    state, swarm, bullets, gems, particles, orbitals, tesla, player, camera, upgrades: UPGRADES,
    spawnBoss,
    bosses: () => ({ active: activeBosses, spawned: bossesSpawned }),
    flags: () => ({ started, over, leveling }),
    quality: () => ({ tier: quality.tier, label: QUALITY_TIERS[quality.tier].label, emaMs: +quality.emaMs.toFixed(2), bloom: bloomEnabled, pixelRatio: renderer.getPixelRatio() }),
    shake: () => shake,
    addShake,
    hitStop: () => hitStop,
    audio: () => ({ ready: sfx.audioReady(), muted: sfx.isMuted() }),
    // test hook: feed a synthetic frame time to the governor and apply any tier change
    feedFrame: (frameMs: number) => {
      if (governQuality(quality, frameMs, targetFrameMs, 1 / 60)) applyQuality();
      return quality.tier;
    },
    backend: () => (onWebGPU() ? 'webgpu' : 'webgl2'),
    bloom: () => !!post,
    step: (dt = 1 / 60, frames = 1) => {
      for (let i = 0; i < frames; i++) {
        if (started && !over && !leveling) update(dt);
        else if (over) particles.update(dt);
        hud.tick(dt);
      }
      if (post && bloomEnabled) post.render();
      else renderer.render(scene, camera);
      prev = performance.now();
    },
  };

  // --- main loop ---
  let prev = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;

  function update(dt: number): void {
    state.time += dt;
    tickCombo(state, dt);

    // muzzle flash: brief glow brighten on fire, decays fast
    if (muzzle > 0.001) {
      muzzle *= Math.pow(0.0005, dt);
      glow.intensity = baseGlow * (1 + muzzle * 0.8);
    }

    const mv = getMove();
    player.position.x += mv.x * state.moveSpeed * dt;
    player.position.z += mv.z * state.moveSpeed * dt;
    if (mv.x !== 0 || mv.z !== 0) {
      const target = Math.atan2(mv.x, mv.z);
      let delta = target - facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      facing += delta * Math.min(1, dt * 12);
      player.rotation.y = facing;
      player.rotation.z = -mv.x * 0.12;
    }

    camera.position.x += (player.position.x - camera.position.x) * Math.min(1, dt * 5);
    camera.position.z += (player.position.z + 15 - camera.position.z) * Math.min(1, dt * 5);
    // transient, zero-mean screen-shake offset (re-centered by the lerp next frame)
    if (shake > 0.001) {
      camera.position.x += (Math.random() * 2 - 1) * shake;
      camera.position.z += (Math.random() * 2 - 1) * shake;
      shake *= Math.pow(0.012, dt); // fast decay
    }
    camera.lookAt(player.position.x, 0, player.position.z);

    grid.build(swarm.posX, swarm.posZ, swarm.count, player.position.x, player.position.z);
    const damage = swarm.update(dt, state.time, player.position.x, player.position.z, grid);
    if (damage > 0) {
      state.hp -= damage;
      hud.damageFlash();
      addShake(Math.min(0.6, damage * 0.04));
      sfx.sfxHurt();
    }
    state.hp = Math.min(state.maxHp, state.hp + state.regen * dt);

    director(dt);

    fireAcc += dt * state.fireRate;
    if (fireAcc > 4) fireAcc = 4;
    while (fireAcc >= 1) {
      fireAcc -= 1;
      fireVolley();
    }

    bullets.update(dt, swarm, grid);

    // secondary weapons read their level from game state each frame
    orbitals.level = state.orbitalLevel;
    orbitals.update(dt, state.time, player.position.x, player.position.z, swarm, grid);
    tesla.level = state.teslaLevel;
    tesla.update(dt, player.position.x, player.position.z, swarm, grid, particles);

    swarm.sweepDead((x, z, xp, type) => {
      state.kills++;
      registerKill(state, type); // combo + score
      const t = ENEMY_TYPES[type];
      if (type === BOSS_TYPE) {
        activeBosses--;
        // bosses pay out a cluster of gems and a big explosion
        for (let g = 0; g < 6; g++) {
          gems.spawn(x + (Math.random() - 0.5) * 3, z + (Math.random() - 0.5) * 3, Math.ceil(xp / 6));
        }
        particles.burst(x, t.radius, z, t.color, 90, 18);
        addShake(1.4);
        hitStop = 0.12; // punchy micro-freeze on the kill
        sfx.sfxBossDie();
      } else {
        gems.spawn(x, z, xp);
        particles.burst(x, t.radius, z, t.color, type >= 2 ? 26 : 10);
        sfx.sfxKill(); // throttled internally
      }
    });

    gems.update(dt, state.time, player.position.x, player.position.z, state.magnet, v => { grantXp(state, v); sfx.sfxPickup(); });
    particles.update(dt);

    if (state.hp <= 0) {
      // death ends the frame — never open a level-up under the game-over screen
      gameOver();
      hud.update(state, swarm.count);
      return;
    }
    if (state.pendingLevels > 0 && !leveling) openLevelUp();

    updateBossBar(dt);
    hud.update(state, swarm.count);
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const rawDt = (now - prev) / 1000;
    const dt = Math.min(0.05, rawDt);
    prev = now;

    fpsFrames++;
    fpsTime += rawDt; // wall clock, so the readout stays honest below 20 FPS
    if (fpsTime >= 0.5) {
      hud.setFps(fpsFrames / fpsTime);
      fpsFrames = 0;
      fpsTime = 0;
    }

    // hold the target frame rate by flexing quality (skip while pinned)
    if (pinnedTier < 0 && governQuality(quality, rawDt * 1000, targetFrameMs, rawDt)) {
      applyQuality();
    }

    // hit-stop: briefly slow the simulation for impact (UI/FPS use real time)
    let simDt = dt;
    if (hitStop > 0) {
      hitStop -= rawDt;
      simDt = dt * 0.18;
    }

    if (started && !over && !leveling) update(simDt);
    else if (over) particles.update(simDt); // let the death explosion play out
    hud.tick(dt);

    if (post && bloomEnabled) post.render();
    else renderer.render(scene, camera);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  document.body.innerHTML = `<div style="color:#ff3355;font-family:monospace;padding:40px">
    Failed to initialize renderer. This game needs WebGPU or WebGL2.<br/><br/>${err}</div>`;
});
