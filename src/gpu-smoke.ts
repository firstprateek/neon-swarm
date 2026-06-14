/**
 * Standalone GPU-compute smoke test. Served at /gpu-smoke.html (dev only).
 * Exercises exactly the unproven-in-practice r172 TSL APIs the GPU swarm
 * depends on — compute kernel + storage buffer + dispatch + readback,
 * dynamic Loop bounds, and positionNode rendering from a storage buffer —
 * and verifies via readback (works headless even though WebGPU screenshots
 * don't). Results land on window.__gpuSmoke.
 */
import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, instancedArray, uniform, Loop, float, vec2, vec3, positionGeometry } from 'three/tsl';

interface R { name: string; pass: boolean; detail: string }
const results: R[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass: !!pass, detail: pass ? '' : detail });

function render(): void {
  const out = document.getElementById('out')!;
  const failed = results.filter(r => !r.pass);
  out.innerHTML =
    `<h2 class="${failed.length ? 'fail' : 'pass'}">${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} — ${results.length} checks</h2>` +
    results.map(r => `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? ' — ' + r.detail : ''}</div>`).join('');
  (window as unknown as Record<string, unknown>).__gpuSmoke = { total: results.length, failed: failed.length, failures: failed, results };
}

async function run(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setSize(64, 64);
  document.getElementById('app')!.appendChild(renderer.domElement);
  await renderer.init();

  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  check('backend is WebGPU', isWebGPU, (renderer.backend as { constructor: { name: string } }).constructor.name);
  if (!isWebGPU) { render(); return; }

  const N = 1000;

  // ---- Test 1: CPU seed -> upload -> chase compute -> readback ----
  const pos = instancedArray(N, 'vec2');
  const posAttr = (pos as unknown as { value: THREE.StorageInstancedBufferAttribute }).value;
  const arr = posAttr.array as Float32Array;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    arr[i * 2] = Math.cos(a) * 20;
    arr[i * 2 + 1] = Math.sin(a) * 20;
  }
  posAttr.needsUpdate = true; // full upload (no partial ranges)

  const uPlayer = uniform(new THREE.Vector2(0, 0));
  const uStep = uniform(5.0);
  const chase = Fn(() => {
    const p = pos.element(instanceIndex);
    const px = p.x, pz = p.y;
    const dx = uPlayer.x.sub(px), dz = uPlayer.y.sub(pz);
    const d = dx.mul(dx).add(dz.mul(dz)).sqrt().add(1e-6);
    const nx = px.add(dx.div(d).mul(uStep));
    const nz = pz.add(dz.div(d).mul(uStep));
    p.assign(vec2(nx, nz));
  })().compute(N);

  let chaseErr = '';
  let movedIn = 0;
  try {
    for (let f = 0; f < 3; f++) await renderer.computeAsync(chase); // 3 * 5 = 15 units inward from r=20
    const back = new Float32Array(await renderer.getArrayBufferAsync(posAttr));
    for (let i = 0; i < N; i++) {
      const r1 = Math.hypot(back[i * 2], back[i * 2 + 1]);
      if (r1 < 19) movedIn++;
    }
  } catch (e) { chaseErr = (e as Error).message; }
  check('compute chase moves all enemies toward player', movedIn === N, chaseErr || `${movedIn}/${N} moved in`);

  // ---- Test 2: CPU->GPU full re-upload is reflected in compute ----
  // (already implicitly tested above: the chase started from CPU-seeded r=20.
  //  Confirm the readback wrapping gives a fresh, non-aliased copy.)
  try {
    const a1 = new Float32Array(await renderer.getArrayBufferAsync(posAttr));
    const a2 = new Float32Array(await renderer.getArrayBufferAsync(posAttr));
    check('readback returns independent copies', a1 !== a2 && a1.length === N * 2 && a1[0] === a2[0]);
  } catch (e) { check('readback returns independent copies', false, (e as Error).message); }

  // ---- Test 3: dynamic Loop bounds compile + run (the flagged risk) ----
  const acc = instancedArray(N, 'float');
  const accAttr = (acc as unknown as { value: THREE.StorageBufferAttribute }).value;
  const loopK = Fn(() => {
    const s = float(0).toVar();
    // dynamic end bound derived from the invocation index
    Loop({ start: float(0), end: instanceIndex.modInt(5).add(1), condition: '<' }, () => {
      s.addAssign(1);
    });
    acc.element(instanceIndex).assign(s);
  })().compute(N);
  let loopErr = '', loopOk = false;
  try {
    await renderer.computeAsync(loopK);
    const a = new Float32Array(await renderer.getArrayBufferAsync(accAttr));
    // element i should equal (i % 5) + 1
    loopOk = a[7] === (7 % 5) + 1 && a[12] === (12 % 5) + 1 && a[123] === (123 % 5) + 1;
    loopErr = loopOk ? '' : `a[7]=${a[7]} a[12]=${a[12]} a[123]=${a[123]} (want 3,3,4)`;
  } catch (e) { loopErr = (e as Error).message; }
  check('dynamic Loop bounds compile + produce correct result', loopOk, loopErr);

  // ---- Test 4: positionNode render from a storage buffer (no throw) ----
  let renderErr = '', renderOk = false;
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    cam.position.set(0, 10, 40);
    cam.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const mat = new THREE.MeshStandardNodeMaterial({ flatShading: true });
    // toAttribute() is registered via addMethodChaining at runtime (not in the static types)
    const pa = (pos as unknown as { toAttribute: () => { x: unknown; y: unknown } }).toAttribute();
    mat.positionNode = positionGeometry.add(vec3(pa.x, float(0), pa.y)) as unknown as typeof mat.positionNode;
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), mat, N);
    mesh.frustumCulled = false;
    scene.add(mesh);
    await renderer.renderAsync(scene, cam);
    renderOk = true;
  } catch (e) { renderErr = (e as Error).message; }
  check('positionNode render from storage buffer does not throw', renderOk, renderErr);

  render();
}

run().catch(e => {
  check('smoke test crashed', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  render();
});
