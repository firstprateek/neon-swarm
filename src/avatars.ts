import * as THREE from 'three/webgpu';

/** survivor display + palette data (also used by the select-screen thumbnails) */
export interface Avatar {
  name: string;
  trait: string;
  skin: number;
  clothes: number;
  legs: number;
  accent: number;
}

export const AVATARS: Avatar[] = [
  { name: 'RANGER',   trait: 'steady all-rounder',  skin: 0x9a6a44, clothes: 0x5b6e3c, legs: 0x33301f, accent: 0xffb24a },
  { name: 'MEDIC',    trait: 'calm under fire',     skin: 0xd8b89a, clothes: 0xc6ccc6, legs: 0x5a5e5a, accent: 0xff5555 },
  { name: 'BIKER',    trait: 'fast & reckless',     skin: 0xb0784a, clothes: 0x2c2c30, legs: 0x1c1c20, accent: 0x44d6ff },
  { name: 'ENGINEER', trait: 'tough & resourceful', skin: 0x7a5436, clothes: 0xff7a1a, legs: 0x4a3a1a, accent: 0xffe24a },
];

/**
 * Build an upright low-poly human survivor as a Group of a handful of boxes —
 * there is exactly ONE player, so per-part materials are free and the hero pops
 * against the flat zombie horde. Feet at y=0, ~1.5 tall.
 */
export function makeSurvivor(a: Avatar): THREE.Group {
  const g = new THREE.Group();
  const mat = (c: number, rough = 0.6) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, flatShading: true });
  const clothes = mat(a.clothes), skin = mat(a.skin, 0.75), legsMat = mat(a.legs), accent = mat(a.accent, 0.4);
  const part = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
  };
  // legs + arms are PIVOTED limbs — the geometry is offset so each mesh's origin sits at the hip /
  // shoulder, letting the walk cycle (main.ts) swing them forward/back. torso + head are static.
  const limb = (w: number, h: number, d: number, m: THREE.Material, x: number, pivotY: number, z = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, -h / 2, 0), m);
    mesh.position.set(x, pivotY, z);
    g.add(mesh);
    return mesh;
  };
  const legR = limb(0.17, 0.58, 0.19, legsMat, 0.11, 0.58);    // hip at y=0.58 (feet reach y=0)
  const legL = limb(0.17, 0.58, 0.19, legsMat, -0.11, 0.58);
  part(new THREE.BoxGeometry(0.44, 0.56, 0.27), clothes, 0, 0.86, 0);      // torso
  const armR = limb(0.14, 0.52, 0.16, clothes, 0.31, 1.11, 0.02);          // shoulder at y=1.11
  const armL = limb(0.14, 0.52, 0.16, clothes, -0.31, 1.11, 0.02);
  part(new THREE.BoxGeometry(0.28, 0.28, 0.28), skin, 0, 1.31, 0.02);      // head
  (g.userData as { rig?: { legL: THREE.Mesh; legR: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh } }).rig = { legL, legR, armL, armR };

  // per-survivor silhouette kit so they're distinct from above
  if (a.name === 'RANGER') {
    part(new THREE.BoxGeometry(0.34, 0.42, 0.16), mat(0x3a3326), 0, 0.92, -0.22); // backpack
    part(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), accent, 0.36, 0.95, 0.18); // slung rifle
  } else if (a.name === 'MEDIC') {
    part(new THREE.BoxGeometry(0.24, 0.07, 0.02), accent, 0, 0.95, 0.15); // red cross
    part(new THREE.BoxGeometry(0.07, 0.24, 0.02), accent, 0, 0.95, 0.15);
  } else if (a.name === 'BIKER') {
    part(new THREE.BoxGeometry(0.32, 0.32, 0.32), mat(0x18181c, 0.2), 0, 1.32, 0.02); // glossy helmet over head
    part(new THREE.BoxGeometry(0.56, 0.1, 0.3), accent, 0, 1.1, 0); // shoulder bar
  } else {
    part(new THREE.ConeGeometry(0.22, 0.2, 8), accent, 0, 1.52, 0.02); // hard hat
    part(new THREE.BoxGeometry(0.08, 0.4, 0.08), mat(0x888888, 0.3), 0.34, 0.7, 0.1); // wrench/pipe
  }
  return g;
}
