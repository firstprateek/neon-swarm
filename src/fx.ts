import * as THREE from 'three/webgpu';

/**
 * Blast — the cinematic nuke detonation: a blinding ground flash, a stack of
 * staggered expanding shockwave rings, and a vertical light pillar (the mushroom
 * stem). All additive + tone-mapping-off so the bloom pass makes it ERUPT.
 *
 * Nukes are rare (max ~3), so a small fixed set of reusable meshes is plenty —
 * detonate() just re-aims them and restarts their animations. Animated on real
 * wall-clock time so it plays out fully even through the hit-stop micro-freeze.
 */

type Kind = 'ring' | 'disc' | 'pillar';

interface Track {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  kind: Kind;
  delay: number; // seconds to wait before this layer fires (staggers the rings)
  dur: number; // animation lifetime in seconds
  maxR: number; // peak horizontal radius / width
  maxH: number; // peak height (pillar only)
  t: number; // elapsed, counts up from -delay
  active: boolean;
}

export class Blast {
  private readonly tracks: Track[] = [];

  constructor(scene: THREE.Scene) {
    const mk = (
      geo: THREE.BufferGeometry, color: number, kind: Kind,
      dur: number, maxR: number, maxH: number, delay: number, flat: boolean,
    ): Track => {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.toneMapped = false; // stay vivid -> bloom picks it up hard
      const mesh = new THREE.Mesh(geo, mat);
      if (flat) mesh.rotation.x = -Math.PI / 2; // lay it on the ground (XZ) plane
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      return { mesh, mat, kind, delay, dur, maxR, maxH, t: 0, active: false };
    };

    // ground flash disc — blinding, near-instant
    this.tracks.push(mk(new THREE.CircleGeometry(1, 48), 0xffffff, 'disc', 0.3, 36, 0, 0, true));
    // shockwave rings — a sharp bright front, a thermal orange wave, a wide late roll
    this.tracks.push(mk(new THREE.RingGeometry(0.9, 1.0, 96), 0xc4fbff, 'ring', 0.55, 62, 0, 0.0, true));
    this.tracks.push(mk(new THREE.RingGeometry(0.82, 1.0, 96), 0xffc24a, 'ring', 0.72, 60, 0, 0.07, true));
    this.tracks.push(mk(new THREE.RingGeometry(0.93, 1.0, 96), 0x9ff0ff, 'ring', 0.9, 66, 0, 0.18, true));
    // vertical light pillar — the mushroom stem
    this.tracks.push(mk(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true), 0xe6fcff, 'pillar', 0.52, 5.5, 30, 0.0, false));
  }

  /** kick off a full detonation centered at (x,z) */
  detonate(x: number, z: number): void {
    for (const tr of this.tracks) {
      tr.t = -tr.delay;
      tr.active = true;
      tr.mesh.visible = false;
      const y = tr.kind === 'disc' ? 0.12 : tr.kind === 'ring' ? 0.2 : 0;
      tr.mesh.position.set(x, y, z);
    }
  }

  /** true while any layer is still animating */
  get active(): boolean {
    return this.tracks.some(t => t.active);
  }

  update(dt: number): void {
    for (const tr of this.tracks) {
      if (!tr.active) continue;
      tr.t += dt;
      if (tr.t < 0) continue; // still waiting out its stagger delay
      const p = tr.t / tr.dur;
      if (p >= 1) { tr.active = false; tr.mesh.visible = false; tr.mat.opacity = 0; continue; }
      tr.mesh.visible = true;
      const out = 1 - (1 - p) * (1 - p); // ease-out: fast then settle
      if (tr.kind === 'ring') {
        const r = out * tr.maxR + 0.5;
        tr.mesh.scale.set(r, r, 1);
        tr.mat.opacity = (1 - p) * 0.9;
      } else if (tr.kind === 'disc') {
        const r = out * tr.maxR + 0.5;
        tr.mesh.scale.set(r, r, 1);
        tr.mat.opacity = (1 - p) * (1 - p); // very fast fade -> a flash
      } else {
        const w = out * tr.maxR + 0.3;
        const h = out * tr.maxH;
        tr.mesh.scale.set(w, h, w);
        tr.mesh.position.y = h / 2;
        tr.mat.opacity = (1 - p) * 0.85;
      }
    }
  }
}
