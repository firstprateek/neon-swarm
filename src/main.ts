import * as THREE from 'three/webgpu';
import { pass, uniform, mix, vec3, screenUV, luminance, clamp, oneMinus,
  Fn, positionWorld, color, smoothstep, mx_fractal_noise_float, mx_noise_float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createState, grantXp, rollUpgrades, registerKill, tickCombo, UPGRADES,
  MISSILE_MAX, NUKE_MAX, MISSILE_REFILL, MISSILE_DMG, MISSILE_AOE, NUKE_DMG } from './state';
import { getMove, getAim, setTouchMove, clearTouchMove, setMouseAim, setKeyMap, heldKeys } from './input';
import { resolveAction, isDown, defaultKeys, isBindable, keyLabel, KEY_ACTIONS, ACTION_LABELS, type KeyAction } from './keybind';
import { type Difficulty, DIFFICULTIES, flagsToPreset, coerceDifficulty } from './modes';
import { createTouch } from './touch';
import { submitFeedback, flushFeedback, beaconFlush, deviceClass, APP_VERSION, type FeedbackCtx } from './feedback';
import { SpatialGrid } from './spatial';
import { Swarm, ENEMY_TYPES, BOSS_TYPE, HIT_FLASH } from './swarm';
import { Bullets, Gems, Particles, Missiles } from './combat';
import { Blast } from './fx';
import { AmbientMotes } from './ambient';
import { Orbitals, Tesla } from './weapons';
import { spawnRate, rollEnemyType, bossHp, hordeSize, BOSS_INTERVAL } from './director';
import { createQuality, governQuality, QUALITY_TIERS, MAX_TIER } from './perf';
import { loadSettings, saveSettings, qualityTier, applyPreset, clampZoom, ZOOM_MAX, type Settings, type QualityMode } from './settings';
import { AVATARS, makeSurvivor } from './avatars';
import { setSeed, getSeed, randomSeed, srand } from './rng';
import { TELEMETRY_ENDPOINT } from './config';
import { track, initTelemetry, wireTelemetryLifecycle } from './telemetry';
import { submitScore, flushScores, beaconFlushScores, fetchBoard } from './leaderboard';
import { normNote, dprBucket, screenTier, refAllow, hostOnly, rotShareToken } from './telemetry-helpers';
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
  const sNode = scene as unknown as { backgroundNode: unknown };
  const prevBgNode = sNode.backgroundNode;
  sNode.backgroundNode = null; // the magenta probe must own the clear, not the gradient node
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
  sNode.backgroundNode = prevBgNode;
  return sum === 0;
}

// §0 telemetry module state (consumed only when the backend flag is on; inert otherwise)
const pageLoadT = performance.now(); // for ttfr_ms; must be before any await
let runsThisSession = 0;             // run_index
let runTainted = false;             // flipped by any cheat / debug poke

async function start() {
  const params = new URLSearchParams(location.search);
  const forceGL = params.has('webgl'); // force the WebGL2 backend
  const pinGPU = params.has('webgpu'); // trust WebGPU, skip the watchdog probe
  const noBloom = params.has('nobloom');

  // backend telemetry boot (all no-ops when the flag is off)
  initTelemetry();
  wireTelemetryLifecycle();
  track('page_view', { referrer_host: refAllow(hostOnly(document.referrer)), utm: params.get('utm_source'), has_seed: params.has('seed') });

  // persisted player settings; URL params still override below
  const settings = loadSettings();
  setKeyMap(settings.keybinds); // wire remappable bindings into the input layer
  let dailyMode: Difficulty = settings.dailyMode; // the locked control tier for a daily run
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
  // a challenge link can carry the control tier so it replays the same assist mode
  if (challengeSeed != null && params.has('mode')) applyPreset(settings, coerceDifficulty(params.get('mode')));
  if (challengeSeed != null) track('challenge_open', { referrer_host: refAllow(hostOnly(document.referrer)), share_token: rotShareToken() });
  let isDaily = false; // current run is today's Daily Challenge
  let dailyNum = 0;

  let renderer = await makeRenderer(forceGL);
  const app = document.getElementById('app')!;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // post-apocalyptic sky: ashen warm horizon -> toxic dark zenith, fog tinted to the
  // horizon so the far ground dissolves into the haze (no seam). Cheap GPU gradient
  // (only a thin top band shows under the steep top-down cam — a dome would be wasted).
  const SKY_HORIZON = 0x1a1410, SKY_ZENITH = 0x0a0c08;
  (scene as unknown as { backgroundNode: unknown }).backgroundNode = mix(
    vec3(...new THREE.Color(SKY_HORIZON).toArray()),
    vec3(...new THREE.Color(SKY_ZENITH).toArray()),
    screenUV.y.smoothstep(0.35, 1.0),
  );
  scene.background = null;
  const FOG_BASE = 0.026; // density at zoom 1; scaled by 1/zoom each frame so zoom-out stays readable
  scene.fog = new THREE.FogExp2(SKY_HORIZON, FOG_BASE);

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

  // procedural wasteland ground (TSL): low-freq dust/scorch mottle, Worley "ruined
  // pavement" crack seams (replaces the GridHelper), and detail blood/scorch splotches
  // gated by uDetail so they tier off cheaply. All luminance < 0.13 -> never blooms.
  const uDetail = uniform(1.0); // 1 full · 0.5 cracks-only · 0 base (set in applyQuality)
  let groundMat: THREE.Material;
  try {
    const groundColor = Fn(() => {
      const p = positionWorld.xz;
      // broad dust <-> dusty-tan mottle (wide palette so cracked earth actually reads)
      const mott = mx_fractal_noise_float(p.mul(0.05), 4, 2.0, 0.5).mul(0.5).add(0.5);
      const base = mix(color(0x141009), color(0x352a18), mott);
      // crack network: near-black lines along a mid-freq noise's zero-crossings
      // (mx_noise_float — identical on WebGPU + WebGL2, unlike worley)
      const crack = smoothstep(0.09, 0.0, mx_noise_float(p.mul(0.3)).abs());
      const seamed = mix(base, color(0x080503), crack);
      // broad dried-blood + scorch splotches, tiered off cheaply by uDetail
      const splotch = mx_fractal_noise_float(p.mul(0.013), 3, 2.0, 0.5).mul(0.5).add(0.5);
      const blood = smoothstep(0.66, 0.82, splotch).mul(uDetail);
      const bloodied = mix(seamed, color(0x3a140f), blood.mul(0.7));     // dried maroon
      const scorch = smoothstep(0.22, 0.04, splotch).mul(uDetail);
      return mix(bloodied, color(0x0a0604), scorch.mul(0.6));            // char / burn
    });
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 1.0, metalness: 0.0 });
    m.colorNode = groundColor();
    groundMat = m;
  } catch (err) {
    console.warn('[neon-swarm] procedural ground unavailable, using flat:', err);
    groundMat = new THREE.MeshStandardMaterial({ color: 0x14110c, roughness: 1 });
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

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
  const ambient = new AmbientMotes(260, scene); // drifting ash + embers (tiered in applyQuality)
  const orbitals = new Orbitals(6, scene);
  const tesla = new Tesla(64, scene);
  const grid = new SpatialGrid(2.5, 96, MAX_ENEMIES);

  // --- post-processing bloom + post-apoc color grade, validated before use ---
  const gradeAmt = uniform(1.0); // tiered in applyQuality(): 1 ultra/high · 0.6 med · 0 low
  let post: { render: () => void } | null = null;
  if (!noBloom) {
    try {
      const postProcessing = new THREE.PostProcessing(renderer);
      const scenePass = pass(scene, camera);
      const color = scenePass.getTextureNode('output');
      // threshold 0.75: only emissive/bright-basic surfaces bloom (player,
      // bullets, gems) — lower thresholds wash the whole horde out
      const lit = color.add(bloom(color, 0.55, 0.35, 0.75)); // BLOOM FIRST — keep neon glows hot
      // grade AFTER bloom: sickly split-tone (cold-teal shadows, sodium-ash highlights)
      // + mild desaturation + a gentle vignette. Luminance-preserving so the horde still pops.
      const lum = luminance(lit.rgb);
      const split = lit.rgb.add(mix(vec3(0.035, 0.065, 0.055), vec3(0.17, 0.115, 0.05), lum.smoothstep(0.15, 0.85)));
      const desat = mix(vec3(lum), split, 0.82);
      const vUV = screenUV.sub(0.5);
      const vig = clamp(oneMinus(vUV.dot(vUV).mul(0.9)), 0.55, 1.0);
      postProcessing.outputNode = mix(lit.rgb, desat.mul(vig), gradeAmt);
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

  // touch device? enables on-screen controls, a tighter DPR ceiling, and visualViewport sizing
  const isTouch = matchMedia('(pointer: coarse)').matches || params.has('touch');
  if (isTouch) document.body.classList.add('touch'); // hides the keyboard-hint ability HUD
  // a 3x-DPR phone renders far too many pixels before the governor reacts — cap it
  const dprCap = (cap: number) => (isTouch ? Math.min(cap, 1.5) : cap);
  const viewportWH = (): [number, number] => {
    const vv = window.visualViewport;
    return [vv?.width ?? window.innerWidth, vv?.height ?? window.innerHeight];
  };

  function applyQuality(): void {
    const tq = QUALITY_TIERS[quality.tier];
    const [w, h] = viewportWH();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap(tq.pixelRatioCap)));
    renderer.setSize(w, h);
    bloomEnabled = bloomAllowed && tq.bloom && !!post;
    // atmosphere tiers DOWN with the governor so the 120fps target always wins
    gradeAmt.value = quality.tier <= 1 ? 1.0 : quality.tier === 2 ? 0.6 : 0.0;
    uDetail.value = quality.tier <= 1 ? 1.0 : quality.tier === 2 ? 0.5 : 0.0;
    ambient.setBudget([260, 160, 90, 0][quality.tier] ?? 160); // ash count tiers down (0 on low)
    const gov = pinnedTier >= 0 ? 'fixed' : `${targetFps}fps target`;
    hud.setBackend(`${onWebGPU() ? 'WebGPU' : 'WebGL2'}${backendNote} · ${gov} · quality: ${tq.label}${bloomEnabled ? '' : ' (no bloom)'}`);
  }
  if (pinnedTier >= 0) quality.tier = pinnedTier;
  applyQuality();

  track('tech_profile', {
    backend: onWebGPU() ? 'webgpu' : 'webgl2', backend_forced: normNote(backendNote), bloom_ok: !!post,
    dpr_bucket: dprBucket(devicePixelRatio), screen_tier: screenTier(screen.width, screen.height), target_fps: targetFps,
  });

  // size from visualViewport (handles the iOS dynamic toolbar) + the mobile DPR cap
  function applySize(): void {
    const [w, h] = viewportWH();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap(QUALITY_TIERS[quality.tier].pixelRatioCap)));
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => requestAnimationFrame(() => requestAnimationFrame(applySize)));
  window.visualViewport?.addEventListener('resize', applySize);

  // --- game flow ---
  let started = false;
  let over = false;
  let leveling = false;
  let paused = false;
  // one source of truth for "input should act": shared by keys and touch buttons
  const canAct = (): boolean => started && !over && !leveling && !paused;
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
    touch?.setFireVisible(!settings.autoFire); // mobile FIRE button only when auto-fire is off
    applyAimMode(); // reticle cursor (desktop) / aim stick (mobile) for manual modes
    sfx.initAudio();
    runsThisSession++;
    track('run_start', {
      mode: isDaily ? dailyMode : 'free', survivor: AVATARS[idx].name,
      daily_num: isDaily ? dailyNum : null, ttfr_ms: Math.round(performance.now() - pageLoadT),
      backend: onWebGPU() ? 'webgpu' : 'webgl2',
    });
  };
  // challenge link drops straight into the run; otherwise pick a survivor first
  const startRun = () => {
    if (challengeSeed != null) deploy(settings.avatar);
    else hud.showAvatarSelect(AVATARS, settings.avatar, deploy);
  };
  track('title_shown', {
    challenge: challengeSeed != null, daily_num: dailyNumber(Date.now()),
    daily_best_local: Math.max(...DIFFICULTIES.map(m => getDailyBest(dailyNumber(Date.now()), m))),
  });
  hud.showStart({
    challengeSeed,
    daily: { num: dailyNumber(Date.now()), best: Math.max(...DIFFICULTIES.map(m => getDailyBest(dailyNumber(Date.now()), m))) },
    onDaily: () => {
      isDaily = true;
      dailyNum = dailyNumber(Date.now());
      setSeed(dailySeed(Date.now())); // global same-seed run for everyone today (mode never touches the seed)
      const cards = DIFFICULTIES.map(m => ({
        mode: m,
        label: m.toUpperCase(),
        tag: { easy: 'auto-fire · auto-aim', medium: 'auto-fire · manual aim', hard: 'fully manual' }[m],
        best: getDailyBest(dailyNum, m),
      }));
      hud.showDailyModeSelect(dailyNum, cards, settings.dailyMode, (m) => {
        dailyMode = m;
        settings.dailyMode = m;
        applyPreset(settings, m); // lock the assist flags for this run
        saveSettings(settings);
        startRun();
      });
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
    if (paused) hud.showPause();
    else { hud.hidePause(); closeSettings(); }
  }

  window.addEventListener('keydown', e => {
    if (e.code === 'KeyM') sfx.toggleMute();
    else if (e.code === 'Escape') { if (settingsOpen()) closeSettings(); else togglePause(); }
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
    runTainted = true; // any cheat taints the run (excluded from the leaderboard)
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
  const musicRange = byId<HTMLInputElement>('set-music');
  const zoomRange = byId<HTMLInputElement>('set-zoom');
  const autofireChk = byId<HTMLInputElement>('set-autofire');
  const gunlockChk = byId<HTMLInputElement>('set-gunlock');
  const misslockChk = byId<HTMLInputElement>('set-misslock');
  const presetBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#set-presets .preset-btn'));
  const keysList = byId('set-keys');
  const settingsOverlay = byId('settings-overlay');
  const controlsLocked = () => isDaily; // daily locks controls for the run; free play stays editable

  // --- keybind remap rows (desktop) ---
  const keyRows = new Map<KeyAction, HTMLButtonElement>();
  function buildKeyRows(): void {
    if (keyRows.size) return;
    for (const a of KEY_ACTIONS) {
      const row = document.createElement('button');
      row.className = 'kb-row';
      row.dataset.action = a;
      row.innerHTML = `<span>${ACTION_LABELS[a]}</span><kbd></kbd>`;
      row.addEventListener('click', () => captureKey(a, row));
      keysList.appendChild(row);
      keyRows.set(a, row);
    }
  }
  function syncKeyControls(): void {
    buildKeyRows();
    for (const a of KEY_ACTIONS) (keyRows.get(a)!.querySelector('kbd') as HTMLElement).textContent = keyLabel(settings.keybinds[a]);
    updateKeyHints();
  }
  // keep the in-game ability HUD's key hints in sync with the (remappable) bindings
  function updateKeyHints(): void {
    byId('ab-missile-key').textContent = `[${keyLabel(settings.keybinds.missile)}]`;
    byId('ab-nuke-key').textContent = `[${keyLabel(settings.keybinds.nuke)}]`;
    byId('ab-dash-key').textContent = `[${keyLabel(settings.keybinds.dash)}]`;
  }
  updateKeyHints(); // initial paint (before any settings open)
  let capturing = false;
  function captureKey(action: KeyAction, row: HTMLButtonElement): void {
    if (controlsLocked() || capturing) return;
    capturing = true;
    row.classList.add('capturing');
    (row.querySelector('kbd') as HTMLElement).textContent = 'PRESS…';
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation(); // never reach game/cheat/pause handlers
      window.removeEventListener('keydown', onKey, true);
      capturing = false;
      row.classList.remove('capturing', 'bad');
      if (e.code === 'Escape') { syncKeyControls(); return; } // cancel
      if (!isBindable(e.code)) { row.classList.add('bad'); syncKeyControls(); return; }
      const old = settings.keybinds[action];
      const other = KEY_ACTIONS.find(k => k !== action && settings.keybinds[k] === e.code);
      settings.keybinds[action] = e.code;
      if (other) settings.keybinds[other] = old; // swap displaced action onto the freed key
      setKeyMap(settings.keybinds); saveSettings(settings); syncKeyControls();
    };
    window.addEventListener('keydown', onKey, true); // capture phase
  }
  byId<HTMLButtonElement>('kb-reset').addEventListener('click', () => {
    if (controlsLocked()) return;
    settings.keybinds = defaultKeys();
    setKeyMap(settings.keybinds); saveSettings(settings); syncKeyControls();
  });

  function syncSettings(): void {
    qSel.value = settings.quality;
    fpsSel.value = String(settings.fps);
    bloomChk.checked = settings.bloom;
    zoomRange.value = String(Math.round(settings.zoom * 100));
    soundChk.checked = settings.sound;
    volRange.value = String(settings.volume);
    musicRange.value = String(settings.music);
    autofireChk.checked = settings.autoFire;
    gunlockChk.checked = settings.gunLock;
    misslockChk.checked = settings.missileLock;
    const p = flagsToPreset(settings); // highlight derived from booleans — never lies
    presetBtns.forEach(b => b.classList.toggle('active', b.dataset.diff === p));
    byId('set-fire-hint').textContent =
      (settings.autoFire ? 'GUN auto-fires' : 'GUN: hold FIRE to shoot') +
      ' · aim ' + (settings.gunLock ? 'auto-locks nearest' : 'follows facing') +
      ' · missile ' + (settings.missileLock ? 'homes' : 'dumb-fires');
    const locked = controlsLocked();
    byId('set-controls').dataset.locked = String(locked);
    byId('set-locked-note').classList.toggle('hidden', !locked);
    if (locked) byId('set-locked-mode').textContent = dailyMode.toUpperCase();
    syncKeyControls();
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

  // manual aim (gunLock off) → desktop reticle cursor + mobile right-thumb aim stick
  function applyAimMode(): void {
    const manual = !settings.gunLock;
    if (!isTouch) document.body.classList.toggle('manual-aim', manual);
    touch?.setAimMode(manual);
  }

  // control mutations are blocked while a daily run locks the tier
  const onCtl = (mut: () => void) => { if (controlsLocked()) return; mut(); applySettings(); applyAimMode(); syncSettings(); };
  autofireChk.addEventListener('change', () => onCtl(() => { settings.autoFire = autofireChk.checked; touch?.setFireVisible(!settings.autoFire); }));
  gunlockChk.addEventListener('change', () => onCtl(() => { settings.gunLock = gunlockChk.checked; }));
  misslockChk.addEventListener('change', () => onCtl(() => { settings.missileLock = misslockChk.checked; }));
  presetBtns.forEach(b => b.addEventListener('click', () => onCtl(() => applyPreset(settings, b.dataset.diff as Difficulty))));

  qSel.addEventListener('change', () => { settings.quality = qSel.value as QualityMode; applySettings(); });
  fpsSel.addEventListener('change', () => { settings.fps = Number(fpsSel.value); applySettings(); });
  bloomChk.addEventListener('change', () => { settings.bloom = bloomChk.checked; applySettings(); });
  soundChk.addEventListener('change', () => { settings.sound = soundChk.checked; applySettings(); });
  volRange.addEventListener('input', () => { settings.volume = Number(volRange.value); applySettings(); });
  musicRange.addEventListener('input', () => { settings.music = Number(musicRange.value); applySettings(); });
  zoomRange.addEventListener('input', () => { settings.zoom = clampZoom(Number(zoomRange.value) / 100); saveSettings(settings); });

  // settings overlay (shared by title gear + pause)
  function settingsOpen(): boolean { return !settingsOverlay.classList.contains('hidden'); }
  function openSettings(): void { syncSettings(); settingsOverlay.classList.remove('hidden'); }
  function closeSettings(): void { settingsOverlay.classList.add('hidden'); }
  byId<HTMLButtonElement>('settings-done').addEventListener('click', closeSettings);
  byId<HTMLButtonElement>('title-gear').addEventListener('click', openSettings);
  byId<HTMLButtonElement>('hud-gear').addEventListener('click', () => togglePause());
  byId<HTMLButtonElement>('pause-settings-btn').addEventListener('click', openSettings);
  byId<HTMLButtonElement>('resume-btn').addEventListener('click', () => togglePause());
  byId<HTMLButtonElement>('pause-restart-btn').addEventListener('click', () => location.reload());

  // tap the backdrop (outside the content) to close — mobile has no Esc key
  const pauseOverlayEl = byId('pause-overlay');
  pauseOverlayEl.addEventListener('click', e => { if (e.target === pauseOverlayEl) togglePause(); });
  settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });

  // mobile zoom buttons (top-right) — desktop uses the wheel + / - keys
  const stepZoom = (d: number) => { settings.zoom = clampZoom(settings.zoom + d); saveSettings(settings); };
  byId<HTMLButtonElement>('zoom-in').addEventListener('pointerdown', e => { e.preventDefault(); stepZoom(-0.15); });
  byId<HTMLButtonElement>('zoom-out').addEventListener('pointerdown', e => { e.preventDefault(); stepZoom(0.15); });

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
  let fireHeld = false; // desktop FIRE key/mouse held (manual auto-fire-off mode)
  const setFireHeld = (v: boolean): void => { fireHeld = v; };
  let facing = 0;
  let muzzle = 0; // muzzle-flash glow pulse, decays each frame
  const baseGlow = glow.intensity;

  function fireVolley(): void {
    const px = player.position.x, pz = player.position.z;
    let dirX = Math.sin(facing), dirZ = Math.cos(facing); // default: where we FACE
    if (settings.gunLock) {                                // ON => auto-aim nearest
      const target = swarm.nearest(px, pz);
      if (target >= 0) {
        const dx = swarm.posX[target] - px, dz = swarm.posZ[target] - pz;
        const d = Math.sqrt(dx * dx + dz * dz) + 1e-6;
        dirX = dx / d;
        dirZ = dz / d;
      }
    } // OFF => keep facing dir, no nearest scan
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
    const homing = settings.missileLock; // ON => aim+seek nearest; OFF => dumb-fire straight along facing
    if (homing) {
      const t = swarm.nearest(px, pz);
      if (t >= 0) { const dx = swarm.posX[t] - px, dz = swarm.posZ[t] - pz; const d = Math.sqrt(dx * dx + dz * dz) + 1e-6; dirX = dx / d; dirZ = dz / d; }
    }
    // launch just ahead of the survivor so it doesn't pop out of their chest
    missiles.fire(px + dirX * 0.9, pz + dirZ * 0.9, dirX, dirZ, MISSILE_DMG, MISSILE_AOE, homing);
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

  // on-screen touch controls (joystick + ability buttons), only on coarse-pointer devices
  const touch = isTouch ? createTouch({ fireMissile, fireNuke, doDash, canAct }) : null;

  window.addEventListener('keydown', e => {
    if (!canAct()) return;
    const a = resolveAction(settings.keybinds, e.code);
    if (a === 'fire') e.preventDefault();              // polled (held) — the volley loop reads it
    else if (a === 'missile') { if (!e.repeat) fireMissile(); }
    else if (a === 'nuke') { if (!e.repeat) fireNuke(); }
    else if (a === 'dash' || e.code === 'ShiftRight') { if (!e.repeat) doDash(); } // ShiftRight = fixed dash alias
  });

  // desktop camera zoom — mouse wheel (during play) + persist held-key zoom on release
  const ZOOM_KEYS = new Set(['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract']);
  window.addEventListener('wheel', e => {
    if (isTouch || !canAct()) return; // only during active play; never steals scroll from menus
    e.preventDefault();
    settings.zoom = clampZoom(settings.zoom + Math.sign(e.deltaY) * 0.1); // wheel down = zoom out (more field)
    saveSettings(settings);
  }, { passive: false });
  window.addEventListener('keyup', e => { if (ZOOM_KEYS.has(e.code)) saveSettings(settings); });

  // desktop MOUSE AIM: unproject the cursor onto the ground (y=0) through the LIVE
  // camera each move, so aim is correct at every zoom; LMB hold-fires, RMB launches a missile.
  if (!isTouch) {
    const _ray = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();
    const _ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const _hit = new THREE.Vector3();
    window.addEventListener('pointermove', e => {
      _ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      _ray.setFromCamera(_ndc, camera);
      if (_ray.ray.intersectPlane(_ground, _hit)) setMouseAim(_hit.x - player.position.x, _hit.z - player.position.z);
    });
    const canvas = renderer.domElement;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      if (!canAct()) return;
      if (e.button === 0) fireMissile();                            // LMB = missile
      else if (e.button === 2) { e.preventDefault(); fireNuke(); }  // RMB = nuke
      // gun fires automatically (Medium) or via the FIRE key (Hard) — see wantFire
    });
  }

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
    const newDailyBest = isDaily ? recordDailyScore(dailyNum, dailyMode, state.score) : false;
    const seed = getSeed();
    // telemetry + global-leaderboard submit (both no-op when the backend flag is off)
    track('run_end', {
      mode: isDaily ? dailyMode : 'free', survivor: AVATARS[settings.avatar].name,
      score: state.score, kills: state.kills, level: state.level, time_s: state.time, combo_peak: state.comboPeak,
      is_daily: isDaily, daily_num: isDaily ? dailyNum : null, new_daily_best: newDailyBest,
      run_index: runsThisSession, tainted: runTainted, end_reason: 'death',
    });
    if (isDaily && !runTainted) {
      submitScore({
        score: state.score, kills: state.kills, level: state.level, time: state.time, combo_peak: state.comboPeak,
        survivor: AVATARS[settings.avatar].name, mode: dailyMode, seed, daily_num: dailyNum,
        backend: onWebGPU() ? 'webgpu' : 'webgl2',
      });
    }
    // anonymous run context for feedback — no UA, no id, no geo (privacy ceiling)
    const fbCtx: FeedbackCtx = {
      appVersion: APP_VERSION,
      backend: onWebGPU() ? 'webgpu' : 'webgl2',
      deviceClass: deviceClass(),
      viewport: `${innerWidth}x${innerHeight}`,
      dpr: Math.round((devicePixelRatio || 1) * 10) / 10,
      locale: navigator.language,
      mode: isDaily ? 'daily' : 'free',
      dailyNum: isDaily ? dailyNum : null,
      dailyMode: isDaily ? dailyMode : null,
      seed, survivor: AVATARS[settings.avatar].name,
      score: state.score, timeS: state.time | 0,
      level: state.level, kills: state.kills, comboPeak: state.comboPeak,
    };
    hud.showGameOver(state, {
      survivor: AVATARS[settings.avatar].name,
      seed,
      // UTM is appended ONLY when the backend is on, so shared links are unchanged while off
      shareUrl: `${location.origin}${location.pathname}?seed=${seed}${isDaily ? `&mode=${dailyMode}` : ''}${TELEMETRY_ENDPOINT ? `&utm_source=${isDaily ? 'challenge' : 'share'}` : ''}`,
      daily: isDaily ? { num: dailyNum, mode: dailyMode, best: getDailyBest(dailyNum, dailyMode), isBest: newDailyBest } : null,
      onFeedback: (input) => submitFeedback(input, fbCtx),
      onShare: (method) => track('share_click', { is_daily: isDaily, method, score: state.score }),
      onBoard: isDaily ? () => fetchBoard(dailyNum, dailyMode) : undefined,
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
    touch, canAct, setTouchMove, clearTouchMove, getMove,
    fireVolley, setFireHeld, getAim, setMouseAim,
    facing: () => facing,
    controls: () => ({ autoFire: settings.autoFire, gunLock: settings.gunLock, missileLock: settings.missileLock }),
    setControls: (p: Partial<Pick<Settings, 'autoFire' | 'gunLock' | 'missileLock'>>) => Object.assign(settings, p),
    isFiring: () => touch?.isFiring() ?? false,
    setFireVisible: (b: boolean) => touch?.setFireVisible(b),
    dashReady: () => dashCd <= 0,
    iframes: () => iframes,
    seed: () => getSeed(),
    setSeed,
    daily: () => ({ isDaily, num: dailyNum, mode: dailyMode }),
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
        ambient.update(dt, camera.position.x, camera.position.z, i / 60);
        hud.tick(dt);
        if (touch) { if (canAct()) touch.show(); else touch.hide(); }
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
    // facing: in MANUAL aim modes (gunLock off) the body faces the AIM input
    // (mouse / aim-stick) — true twin-stick; otherwise it follows movement.
    const am = settings.gunLock ? null : getAim();
    if (am) {
      facing = Math.atan2(am.x, am.z); // mouse/stick is already smooth → snap
      player.rotation.y = facing;
      player.rotation.z = -mv.x * 0.12; // lean still follows movement
    } else if (mv.x !== 0 || mv.z !== 0) {
      const target = Math.atan2(mv.x, mv.z);
      let delta = target - facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      facing += delta * Math.min(1, dt * 12);
      player.rotation.y = facing;
      player.rotation.z = -mv.x * 0.12;
    }

    // keyboard zoom (held +/-), desktop only — '+' zooms IN (closer), '-' zooms OUT
    if (!isTouch) {
      const held = heldKeys();
      const zr = 0.9 * dt;
      if (held.has('Equal') || held.has('NumpadAdd')) settings.zoom = clampZoom(settings.zoom - zr);
      if (held.has('Minus') || held.has('NumpadSubtract')) settings.zoom = clampZoom(settings.zoom + zr);
    }
    // zoom = dolly the follow-cam along its angle (height 26 + back 15 scaled together)
    const zlerp = Math.min(1, dt * 5);
    camera.position.x += (player.position.x - camera.position.x) * zlerp;
    camera.position.y += (26 * settings.zoom - camera.position.y) * zlerp;
    camera.position.z += (player.position.z + 15 * settings.zoom - camera.position.z) * zlerp;
    // fog is camera-distance based, so dollying out would over-fog everything (incl. the
    // player). Scale density by 1/zoom to hold the haze at the player constant, THEN cut it
    // by up to 75% as you zoom OUT (0 at default, −75% at max) so the player stays clear.
    const zoomOut = Math.min(1, Math.max(0, (settings.zoom - 1) / (ZOOM_MAX - 1)));
    (scene.fog as THREE.FogExp2).density = (FOG_BASE / settings.zoom) * (1 - 0.75 * zoomOut);
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

    // gun fires automatically, OR only while a FIRE control is held (auto-fire OFF)
    const wantFire = settings.autoFire
      || isDown(settings.keybinds, heldKeys(), 'fire')   // desktop polled FIRE key
      || (touch?.isFiring() ?? false)                    // mobile FIRE button
      || fireHeld;                                       // mouse/explicit hold
    if (wantFire) {
      fireAcc += dt * state.fireRate;
      if (fireAcc > 4) fireAcc = 4;
      while (fireAcc >= 1) {
        fireAcc -= 1;
        fireVolley();
      }
    } else {
      fireAcc = 0; // no bank-up: a tap fires exactly one volley
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
    touch?.setAbilityState(state.missiles, state.nukes, dashCd <= 0);
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
    ambient.update(dt, camera.position.x, camera.position.z, now / 1000); // the dead world keeps breathing
    hud.tick(dt);
    if (touch) { if (canAct()) touch.show(); else touch.hide(); } // show only during active play

    if (post && bloomEnabled) post.render();
    else renderer.render(scene, camera);
  });

  // feedback + leaderboard: flush any queued items (all no-op until the backend flag
  // is set), and try a last-ditch beacon when the tab closes (covers RESTART's reload)
  flushFeedback();
  flushScores();
  window.addEventListener('pagehide', () => { beaconFlush(); beaconFlushScores(); });
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushScores(); });
}

start().catch(err => {
  console.error('Failed to start:', err);
  document.body.innerHTML = `<div style="color:#ff3355;font-family:monospace;padding:40px">
    Failed to initialize renderer. This game needs WebGPU or WebGL2.<br/><br/>${err}</div>`;
});
