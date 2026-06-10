import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createState, xpForLevel, rollUpgrades } from './state';
import { getMove } from './input';
import { SpatialGrid } from './spatial';
import { Swarm, ENEMY_TYPES } from './swarm';
import { Bullets, Gems, Particles } from './combat';
import * as hud from './hud';

const MAX_ENEMIES = 20000;

async function start() {
  // ?webgl forces the WebGL2 backend (useful for envs with broken WebGPU presentation)
  // alpha: false → opaque canvas: correct for a fullscreen game and avoids
  // premultiplied-alpha compositing issues in headless captures
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    alpha: false,
    forceWebGL: location.search.includes('webgl'),
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();
  document.getElementById('app')!.appendChild(renderer.domElement);

  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  hud.setBackend(`${isWebGPU ? 'WebGPU' : 'WebGL2 (fallback)'} · ${MAX_ENEMIES.toLocaleString()} max swarm · 1 draw call`);

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

  // --- systems ---
  const state = createState();
  const swarm = new Swarm(MAX_ENEMIES, scene);
  const bullets = new Bullets(4096, scene);
  const gems = new Gems(4096, scene);
  const particles = new Particles(8192, scene);
  const grid = new SpatialGrid(2.5, 96, MAX_ENEMIES);

  // debug/benchmark hook: spawn a ring of n enemies around the player
  // (grants effectively infinite HP — it's a stress test, not a fair fight)
  (window as unknown as Record<string, unknown>).__spawnTest = (n: number) => {
    state.maxHp = state.hp = 1e9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 15 + Math.random() * 45;
      swarm.spawn((Math.random() * ENEMY_TYPES.length) | 0, player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
    }
    return swarm.count;
  };

  // --- post-processing bloom (graceful fallback to plain render) ---
  let post: { render: () => void } | null = null;
  try {
    if (location.search.includes('nobloom')) throw new Error('bloom disabled via ?nobloom');
    const postProcessing = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    postProcessing.outputNode = color.add(bloom(color, 0.65, 0.45, 0.3));
    post = postProcessing;
  } catch (err) {
    console.warn('Bloom unavailable, rendering without post-processing:', err);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- game flow ---
  let started = false;
  let over = false;
  let leveling = false;
  hud.showStart(() => { started = true; });

  function openLevelUp(): void {
    leveling = true;
    hud.showLevelUp(rollUpgrades(3), u => {
      u.count++;
      u.apply(state);
      state.pendingLevels--;
      hud.update(state, swarm.count);
      if (state.pendingLevels > 0) openLevelUp();
      else leveling = false;
    });
  }

  function gainXp(v: number): void {
    state.xp += v;
    while (state.xp >= state.xpNeed) {
      state.xp -= state.xpNeed;
      state.level++;
      state.xpNeed = xpForLevel(state.level);
      state.pendingLevels++;
    }
  }

  // --- spawn director ---
  let spawnAcc = 0;
  let hordeTimer = 40;

  function pickType(t: number): number {
    const r = Math.random();
    if (t > 240 && r < 0.06) return 3;
    if (t > 100 && r < 0.18) return 2;
    if (t > 35 && r < 0.4) return 1;
    return 0;
  }

  function director(dt: number): void {
    if (swarm.count > MAX_ENEMIES - 64) return;
    const t = state.time;
    spawnAcc += dt * (2 + t * 0.085);
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const rad = 52 + Math.random() * 18;
      swarm.spawn(pickType(t), player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
    }
    hordeTimer -= dt;
    if (hordeTimer <= 0) {
      hordeTimer = 40;
      const n = Math.min(500, 80 + t * 1.2) | 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rad = 58 + Math.random() * 8;
        swarm.spawn(pickType(t + 30), player.position.x + Math.cos(a) * rad, player.position.z + Math.sin(a) * rad);
      }
    }
  }

  // --- firing ---
  let fireAcc = 0;
  let facing = 0;

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
  }

  function gameOver(): void {
    over = true;
    particles.burst(player.position.x, 1, player.position.z, new THREE.Color(0x44ffee), 160, 16);
    player.visible = false;
    hud.showGameOver(state);
  }

  // --- main loop ---
  let prev = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;

  function update(dt: number): void {
    state.time += dt;

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
    camera.lookAt(player.position.x, 0, player.position.z);

    grid.build(swarm.posX, swarm.posZ, swarm.count, player.position.x, player.position.z);
    const damage = swarm.update(dt, state.time, player.position.x, player.position.z, grid);
    if (damage > 0) {
      state.hp -= damage;
      hud.damageFlash();
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

    swarm.sweepDead((x, z, xp, type) => {
      state.kills++;
      gems.spawn(x, z, xp);
      const t = ENEMY_TYPES[type];
      particles.burst(x, t.radius, z, t.color, type >= 2 ? 26 : 10);
    });

    gems.update(dt, state.time, player.position.x, player.position.z, state.magnet, gainXp);
    particles.update(dt);

    if (state.hp <= 0) gameOver();
    if (state.pendingLevels > 0 && !leveling) openLevelUp();

    hud.update(state, swarm.count);
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      hud.setFps(fpsFrames / fpsTime);
      fpsFrames = 0;
      fpsTime = 0;
    }

    if (started && !over && !leveling) update(dt);
    hud.tick(dt);

    if (post) post.render();
    else renderer.render(scene, camera);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  document.body.innerHTML = `<div style="color:#ff3355;font-family:monospace;padding:40px">
    Failed to initialize renderer. This game needs WebGPU or WebGL2.<br/><br/>${err}</div>`;
});
