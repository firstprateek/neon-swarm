import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createState, grantXp, rollUpgrades, registerKill, tickCombo, UPGRADES,
  MISSILE_MAX, NUKE_MAX, MISSILE_REFILL, MISSILE_DMG, MISSILE_AOE, NUKE_DMG } from './state';
import { getMove } from './input';
import { SpatialGrid } from './spatial';
import { Swarm, ENEMY_TYPES, BOSS_TYPE, HIT_FLASH } from './swarm';
import { Bullets, Gems, Particles, Missiles } from './combat';
import { Blast } from './fx';
import { Orbitals, Tesla } from './weapons';
import { spawnRate, rollEnemyType, bossHp, hordeSize, BOSS_INTERVAL } from './director';
import { createQuality, governQuality, QUALITY_TIERS, MAX_TIER } from './perf';
import { loadSettings, saveSettings, qualityTier, type Settings, type QualityMode } from './settings';
import { AVATARS, makeSurvivor } from './avatars';
import { setSeed, getSeed, randomSeed, srand } from './rng';
import { dailySeed, dailyNumber, getDailyBest, recordDailyScore } from './daily';
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

  // persisted player settings; URL params still override below
  const settings = loadSettings();
  let targetFps = settings.fps;
  let targetFrameMs = 1000 / targetFps;
  // pinnedTier >= 0 pins a quality tier and disables the adaptive governor; -1 = auto
  let pinnedTier = qualityTier(settings.quality);
  let bloomAllowed = settings.bloom; // user bloom toggle (separate from the per-tier flag)
  if (params.has('fps')) { targetFps = Math.max(30, Number(params.get('fps')) || 120); targetFrameMs = 1000 / targetFps; }
  if (params.has('quality')) pinnedTier = Math.max(-1, Math.min(MAX_TIER, Number(params.get('quality')) | 0));
  if (noBloom) bloomAllowed = false;

  // seed the gameplay sim. ?seed=N => a challenge link replaying that exact run.
  // Otherwise the seed is chosen when the player picks a mode (daily/free) at the
  // title screen; we set a provisional random seed now so any pre-start use is sane.
  const challengeSeed = params.has('seed') ? (Number(params.get('seed')) >>> 0) : null;
  setSeed(challengeSeed != null ? challengeSeed : randomSeed());
  let isDaily = false; // current run is today's Daily Challenge
  let dailyNum = 0;

  let renderer = await makeRenderer(forceGL);
  const app = document.getElementById('app')!;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // warm-dark toxic dusk
  scene.background = new THREE.Color(0x0c0a07);
  scene.fog = new THREE.FogExp2(0x0c0a07, 0.02);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 26, 15);
  camera.lookAt(0, 0, 0);

  // neutral lights so instance colors read true (tinted lights wash the palette
  // out). Ambient kept high so the muted apocalypse horde stays readable against
  // the dark ground even away from the player's glow.
  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(20, 40, 10);
  scene.add(dir);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshStandardMaterial({ color: 0x14110c, roughness: 1 }) // cracked earth
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const gridHelper = new THREE.GridHelper(1200, 240, 0x2a2418, 0x171208); // ruined-pavement amber-brown
  scene.add(gridHelper);

  // --- player: a procedural human survivor (swappable avatar) ---
  const player = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({ color: AVATARS[settings.avatar].accent });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.05, 8, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.1;
  player.add(ring);
  const glow = new THREE.PointLight(AVATARS[settings.avatar].accent, 70, 26, 1.8);
  glow.position.y = 3;
  player.add(glow);
  let survivor: THREE.Group | null = null;
  function setAvatar(idx: number): void {
    if (survivor) {
      player.remove(survivor);
      survivor.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => mat.dispose());
      });
    }
    const a = AVATARS[idx];
    survivor = makeSurvivor(a);
    player.add(survivor);
    ringMat.color.setHex(a.accent);
    glow.color.setHex(a.accent);
  }
  setAvatar(settings.avatar);
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
  const missiles = new Missiles(24, scene);
  const blast = new Blast(scene); // cinematic nuke detonation FX
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
  let bloomEnabled = !!post;

  function applyQuality(): void {
    const tq = QUALITY_TIERS[quality.tier];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tq.pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    bloomEnabled = bloomAllowed && tq.bloom && !!post;
    const gov = pinnedTier >= 0 ? 'fixed' : `${targetFps}fps target`;
    hud.setBackend(`${onWebGPU() ? 'WebGPU' : 'WebGL2'}${backendNote} · ${gov} · quality: ${tq.label}${bloomEnabled ? '' : ' (no bloom)'}`);
  }
  if (pinnedTier >= 0) quality.tier = pinnedTier;
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
  let paused = false;
  let godMode = false; // cheat: invincibility
  let shake = 0; // screen-shake magnitude, decays each frame
  const addShake = (a: number) => { shake = Math.min(2.2, shake + a); };
  let hitStop = 0; // brief slow-mo (seconds of real time) for impact on big events
  // active abilities
  let missileRefillTimer = MISSILE_REFILL;
  let dashCd = 0;     // dash cooldown remaining
  let dashTime = 0;   // dash burst remaining
  let dashDirX = 0, dashDirZ = 1;
  let iframes = 0;    // invulnerability window (during/after dash)
  const DASH_COOLDOWN = 2.2, DASH_TIME = 0.16, DASH_SPEED = 70, DASH_IFRAMES = 0.3;

  // apply persisted audio settings (URL ?mute still wins)
  sfx.setVolume(settings.volume / 100);
  sfx.setMuted(!settings.sound);
  if (params.has('mute')) sfx.setMuted(true);

  const deploy = (idx: number) => {
    settings.avatar = idx;
    saveSettings(settings);
    setAvatar(idx);
    started = true;
    sfx.initAudio();
  };
  // challenge link drops straight into the run; otherwise pick a survivor first
  const startRun = () => {
    if (challengeSeed != null) deploy(settings.avatar);
    else hud.showAvatarSelect(AVATARS, settings.avatar, deploy);
  };
  hud.showStart({
    challengeSeed,
    daily: { num: dailyNumber(Date.now()), best: getDailyBest(dailyNumber(Date.now())) },
    onDaily: () => {
      isDaily = true;
      dailyNum = dailyNumber(Date.now());
      setSeed(dailySeed(Date.now())); // global same-seed run for everyone today
      startRun();
    },
    onFreePlay: () => {
      // a challenge link keeps its given seed; plain free play rolls a fresh one
      if (challengeSeed == null) setSeed(randomSeed());
      startRun();
    },
  });

  function togglePause(): void {
    if (!started || over || leveling) return; // can't pause pre-start, dead, or mid-level-up
    paused = !paused;
    if (paused) { syncPauseControls(); hud.showPause(); }
    else hud.hidePause();
  }

  window.addEventListener('keydown', e => {
    if (e.code === 'KeyM') sfx.toggleMute();
    else if (e.code === 'Escape') togglePause();
  });

  // --- cheat codes: type the sequence anytime ---
  const cheats: { code: string; effect: () => string }[] = [
    { code: 'god', effect: () => { godMode = !godMode; return godMode ? 'GOD MODE ON' : 'GOD MODE OFF'; } },
    { code: 'guns', effect: () => { state.dmg = 80; state.fireRate = 14; state.projectiles = 8; state.pierce = 6; state.bulletSpeed = 48; state.orbitalLevel = 5; state.teslaLevel = 5; return 'MAX WEAPONS'; } },
    { code: 'tank', effect: () => { state.maxHp += 200; state.hp = state.maxHp; return '+200 MAX HP'; } },
    { code: 'boss', effect: () => { spawnBoss(); return 'BOSS SUMMONED'; } },
    { code: 'horde', effect: () => { for (let i = 0; i < 400; i++) { const a = Math.random() * Math.PI * 2, r = 18 + Math.random() * 40; swarm.spawn((Math.random() * BOSS_TYPE) | 0, player.position.x + Math.cos(a) * r, player.position.z + Math.sin(a) * r); } return 'HORDE SUMMONED'; } },
    { code: 'rich', effect: () => { state.score += 10000; return '+10000 SCORE'; } },
    { code: 'levelup', effect: () => { state.pendingLevels++; return 'LEVEL UP'; } },
  ];
  let cheatBuf = '';
  function applyCheat(name: string): string | null {
    const c = cheats.find(x => x.code === name);
    if (!c) return null;
    const msg = c.effect();
    hud.toast('✓ ' + msg);
    return msg;
  }
  window.addEventListener('keydown', e => {
    if (e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;
    cheatBuf = (cheatBuf + e.key.toLowerCase()).slice(-16);
    for (const c of cheats) {
      if (cheatBuf.endsWith(c.code)) { applyCheat(c.code); cheatBuf = ''; break; }
    }
  });

  // --- pause-menu settings controls ---
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const qSel = byId<HTMLSelectElement>('set-quality');
  const fpsSel = byId<HTMLSelectElement>('set-fps');
  const bloomChk = byId<HTMLInputElement>('set-bloom');
  const soundChk = byId<HTMLInputElement>('set-sound');
  const volRange = byId<HTMLInputElement>('set-volume');

  function syncPauseControls(): void {
    qSel.value = settings.quality;
    fpsSel.value = String(settings.fps);
    bloomChk.checked = settings.bloom;
    soundChk.checked = settings.sound;
    volRange.value = String(settings.volume);
  }

  function applySettings(): void {
    targetFps = settings.fps;
    targetFrameMs = 1000 / targetFps;
    pinnedTier = qualityTier(settings.quality);
    if (pinnedTier >= 0) quality.tier = pinnedTier;
    bloomAllowed = settings.bloom;
    sfx.setMuted(!settings.sound);
    sfx.setVolume(settings.volume / 100);
    applyQuality();
    saveSettings(settings);
  }

  qSel.addEventListener('change', () => { settings.quality = qSel.value as QualityMode; applySettings(); });
  fpsSel.addEventListener('change', () => { settings.fps = Number(fpsSel.value); applySettings(); });
  bloomChk.addEventListener('change', () => { settings.bloom = bloomChk.checked; applySettings(); });
  soundChk.addEventListener('change', () => { settings.sound = soundChk.checked; applySettings(); });
  volRange.addEventListener('input', () => { settings.volume = Number(volRange.value); applySettings(); });
  byId<HTMLButtonElement>('resume-btn').addEventListener('click', () => togglePause());
  byId<HTMLButtonElement>('pause-restart-btn').addEventListener('click', () => location.reload());

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
    const a = srand() * Math.PI * 2;
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
      const a = srand() * Math.PI * 2;
      const rad = 52 + srand() * 18;
      swarm.spawn(rollEnemyType(t), player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
    }

    hordeTimer -= dt;
    if (hordeTimer <= 0) {
      hordeTimer = 40;
      const n = hordeSize(t);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rad = 58 + srand() * 8;
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

  // combo-milestone celebrations: each fires once per run (never re-fires on a
  // combo reset+reclimb), and a single-frame mass kill celebrates only the
  // highest milestone crossed — no toast/audio/shake spam
  const COMBO_MILESTONES = [10, 25, 50, 100, 200];
  let comboMilestoneIdx = 0;
  function checkComboMilestones(): void {
    if (comboMilestoneIdx >= COMBO_MILESTONES.length || state.combo < COMBO_MILESTONES[comboMilestoneIdx]) return;
    while (comboMilestoneIdx < COMBO_MILESTONES.length && state.combo >= COMBO_MILESTONES[comboMilestoneIdx]) comboMilestoneIdx++;
    const milestone = COMBO_MILESTONES[comboMilestoneIdx - 1];
    const mult = (1 + Math.min(state.combo, 40) * 0.1).toFixed(1);
    const sp = projectToScreen(player.position.x, 3, player.position.z);
    if (sp) hud.floatText(sp.sx, sp.sy - 40, `✦ ${milestone} COMBO  ×${mult} ✦`, '#ff8af0');
    sfx.sfxLevelUp();
    addShake(0.3);
  }

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

  // --- active abilities ---
  function fireMissile(): void {
    if (state.missiles <= 0) { hud.toast('NO MISSILES'); return; }
    const px = player.position.x, pz = player.position.z;
    let dirX = Math.sin(facing), dirZ = Math.cos(facing);
    const t = swarm.nearest(px, pz);
    if (t >= 0) { const dx = swarm.posX[t] - px, dz = swarm.posZ[t] - pz; const d = Math.sqrt(dx * dx + dz * dz) + 1e-6; dirX = dx / d; dirZ = dz / d; }
    // launch just ahead of the survivor so it doesn't pop out of their chest
    missiles.fire(px + dirX * 0.9, pz + dirZ * 0.9, dirX, dirZ, MISSILE_DMG, MISSILE_AOE);
    state.missiles--;
    // muzzle flash so the launch reads as a real "fire"
    particles.burst(px + dirX * 1.1, 0.7, pz + dirZ * 1.1, new THREE.Color(0xffe6b0), 22, 18);
    addShake(0.35);
    sfx.sfxFire();
  }

  function fireNuke(): void {
    if (state.nukes <= 0) { hud.toast('NO NUKES'); return; }
    state.nukes--;
    const px = player.position.x, pz = player.position.z;
    // clear the visible field; bosses only take a heavy dent
    for (let i = 0; i < swarm.count; i++) {
      const dx = swarm.posX[i] - px, dz = swarm.posZ[i] - pz;
      if (dx * dx + dz * dz < 62 * 62) {
        swarm.hp[i] -= swarm.type[i] === BOSS_TYPE ? 450 : NUKE_DMG;
        swarm.flash[i] = HIT_FLASH;
      }
    }
    // EPIC detonation: shockwave rings + ground flash + light pillar, plus
    // layered debris — a white-hot core, a fast cyan energy ring, falling embers.
    blast.detonate(px, pz);
    particles.burst(px, 1.4, pz, new THREE.Color(0xffffff), 140, 30); // white-hot core
    particles.burst(px, 0.9, pz, new THREE.Color(0x9ff0ff), 110, 46); // fast energy ring
    particles.burst(px, 0.6, pz, new THREE.Color(0xffae3a), 130, 16); // fire / falling embers
    hud.flash('#e6fcff', 1);
    addShake(2.6); // clamps to the shake cap, but spends it all
    hitStop = 0.22; // a heavier freeze for weight
    sfx.sfxBossDie();
    hud.toast('☢ NUCLEAR STRIKE');
  }

  function doDash(): void {
    if (dashCd > 0) return;
    const mv = getMove();
    if (mv.x !== 0 || mv.z !== 0) { dashDirX = mv.x; dashDirZ = mv.z; }
    else { dashDirX = Math.sin(facing); dashDirZ = Math.cos(facing); }
    dashTime = DASH_TIME;
    dashCd = DASH_COOLDOWN;
    iframes = DASH_IFRAMES;
    addShake(0.15);
    sfx.sfxPickup();
  }

  window.addEventListener('keydown', e => {
    if (!started || over || leveling || paused) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) fireMissile(); }
    else if (e.code === 'KeyQ') { if (!e.repeat) fireNuke(); }
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { if (!e.repeat) doDash(); }
  });

  // wall-clock ability cooldown + missile refill (unaffected by hit-stop slow-mo)
  function tickRealtime(rdt: number): void {
    if (dashCd > 0) dashCd -= rdt;
    if (state.missiles < MISSILE_MAX) {
      missileRefillTimer -= rdt;
      if (missileRefillTimer <= 0) { state.missiles++; missileRefillTimer = MISSILE_REFILL; }
    } else {
      missileRefillTimer = MISSILE_REFILL; // primed at max so the next drop starts a fresh timer
    }
  }

  function gameOver(): void {
    over = true;
    particles.burst(player.position.x, 1, player.position.z, new THREE.Color(0x44ffee), 160, 16);
    player.visible = false;
    addShake(2.0);
    sfx.sfxDeath();
    hud.hideBoss();
    const newDailyBest = isDaily ? recordDailyScore(dailyNum, state.score) : false;
    const seed = getSeed();
    hud.showGameOver(state, {
      survivor: AVATARS[settings.avatar].name,
      seed,
      shareUrl: `${location.origin}${location.pathname}?seed=${seed}`,
      daily: isDaily ? { num: dailyNum, best: getDailyBest(dailyNum), isBest: newDailyBest } : null,
    });
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
    flags: () => ({ started, over, leveling, paused }),
    togglePause,
    applyCheat,
    godMode: () => godMode,
    quality: () => ({ tier: quality.tier, label: QUALITY_TIERS[quality.tier].label, emaMs: +quality.emaMs.toFixed(2), bloom: bloomEnabled, pixelRatio: renderer.getPixelRatio() }),
    shake: () => shake,
    addShake,
    hitStop: () => hitStop,
    missiles, fireMissile, fireNuke, doDash,
    blast, blastActive: () => blast.active,
    dashReady: () => dashCd <= 0,
    iframes: () => iframes,
    seed: () => getSeed(),
    setSeed,
    daily: () => ({ isDaily, num: dailyNum }),
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
        if (started && !over && !leveling && !paused) { tickRealtime(dt); update(dt); }
        else if (over) particles.update(dt);
        blast.update(dt);
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

    // i-frames decay with the (possibly hit-stop-scaled) sim — fine, they're
    // part of the dash action; the wall-clock cooldown/refill are in tickRealtime
    if (iframes > 0) iframes -= dt;

    const mv = getMove();
    player.position.x += mv.x * state.moveSpeed * dt;
    player.position.z += mv.z * state.moveSpeed * dt;
    // dash burst (fast, brief)
    if (dashTime > 0) {
      dashTime -= dt;
      player.position.x += dashDirX * DASH_SPEED * dt;
      player.position.z += dashDirZ * DASH_SPEED * dt;
    }
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
    if (damage > 0 && !godMode && iframes <= 0) {
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
    missiles.update(dt, swarm, grid, particles, () => addShake(0.3));

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
          gems.spawn(x + (srand() - 0.5) * 3, z + (srand() - 0.5) * 3, Math.ceil(xp / 6));
        }
        particles.burst(x, t.radius, z, t.color, 90, 18);
        addShake(1.4);
        hitStop = 0.12; // punchy micro-freeze on the kill
        sfx.sfxBossDie();
        // boss reward: restock the active-ability arsenal
        state.missiles = MISSILE_MAX;
        if (state.nukes < NUKE_MAX) state.nukes++;
        hud.toast('BOSS DOWN — ARSENAL RESTOCKED');
      } else {
        gems.spawn(x, z, xp);
        particles.burst(x, t.radius, z, t.color, type >= 2 ? 26 : 10);
        sfx.sfxKill(); // throttled internally
      }
    });

    checkComboMilestones();
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
    hud.setAbilities(state.missiles, state.nukes, dashCd <= 0);
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

    if (started && !over && !leveling && !paused) { tickRealtime(dt); update(simDt); }
    else if (over) particles.update(simDt); // let the death explosion play out
    blast.update(dt); // real-time so the nuke FX plays out through hit-stop / level-up
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
