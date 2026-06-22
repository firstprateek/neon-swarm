import { WORLD, type City } from './city';
import type { Swarm } from './swarm';

// single source of truth — these mirror city.ts's WORLD so the map can't silently drift from the sim
const SIZE = WORLD.SIZE, HALF = WORLD.HALF, BOUND = WORLD.BOUND;

/**
 * Top-right minimap: a zoomed-out map of the finite world. The STATIC layer
 * (zones, terrain, landmarks, boundary) is pre-rendered to an offscreen canvas
 * once per city build; each frame just blits it and stamps the dynamic markers
 * (the player arrow + any bosses). Pure 2D canvas — no impact on the 3D scene.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private readonly bgCtx: CanvasRenderingContext2D;
  private readonly reveal: HTMLCanvasElement;   // fog-of-war mask — opaque where you've explored
  private readonly revealCtx: CanvasRenderingContext2D;
  private readonly wrap: HTMLElement;
  private readonly size: number;
  private readonly bossType: number;
  private shown = false;

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement, bossType: number) {
    this.size = canvas.width;
    this.ctx = canvas.getContext('2d')!;
    this.wrap = wrap;
    this.bossType = bossType;
    this.bg = document.createElement('canvas');
    this.bg.width = this.bg.height = this.size;
    this.bgCtx = this.bg.getContext('2d')!;
    this.reveal = document.createElement('canvas');
    this.reveal.width = this.reveal.height = this.size;
    this.revealCtx = this.reveal.getContext('2d')!;
  }

  show(): void { if (!this.shown) { this.shown = true; this.wrap.style.display = 'block'; } }
  hide(): void { if (this.shown) { this.shown = false; this.wrap.style.display = 'none'; } }
  /** uncover the entire map (the 'padirules' cheat) */
  revealAll(): void { this.revealCtx.fillStyle = '#fff'; this.revealCtx.fillRect(0, 0, this.size, this.size); }

  private px(x: number): number { return (x + HALF) / SIZE * this.size; }
  private py(z: number): number { return (z + HALF) / SIZE * this.size; }
  private tri(c: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y + s); c.lineTo(x - s, y + s); c.closePath(); c.fill();
  }

  /** pre-render the static map (zones + terrain + landmarks) for the current seed */
  rebuild(city: City): void {
    const c = this.bgCtx, S = this.size;
    c.clearRect(0, 0, S, S);
    this.revealCtx.clearRect(0, 0, S, S); // new map → re-fog everything
    // zone fields — sample zoneAt over a coarse grid (matches the ground palette)
    const N = 60, cs = S / N;
    const zoneCol = ['#46536e', '#7c6336', '#356e2c']; // downtown blue-grey / suburb tan / park green (brightened to read on a small panel)
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const wx = (gx + 0.5) / N * SIZE - HALF, wz = (gy + 0.5) / N * SIZE - HALF;
        c.fillStyle = zoneCol[city.zoneAt(wx, wz)] ?? zoneCol[0];
        c.fillRect(gx * cs, gy * cs, cs + 1, cs + 1);
      }
    }
    // terrain: lakes (blue discs) + park mountains (grey peaks)
    const o = city.obstacles;
    for (let i = 0; i < o.count; i++) {
      const k = o.kind[i]; if (k !== 8 && k !== 10) continue;
      const x = this.px((o.minX[i] + o.maxX[i]) / 2), y = this.py((o.minZ[i] + o.maxZ[i]) / 2);
      if (k === 10) { c.fillStyle = '#3aa6e0'; c.beginPath(); c.arc(x, y, S * 0.016, 0, 7); c.fill(); }
      else { c.fillStyle = '#9a9a8e'; this.tri(c, x, y, S * 0.017); }
    }
    // the climbable mountain (bright green peak)
    c.fillStyle = '#aaff7a'; this.tri(c, this.px(city.climb.x), this.py(city.climb.z), S * 0.028);
    // boundary ring
    const x0 = this.px(-BOUND), w = this.px(BOUND) - x0;
    c.strokeStyle = 'rgba(255,210,74,0.45)'; c.lineWidth = S * 0.01; c.strokeRect(x0, x0, w, w);
    // zone labels (faint, down the +z radial)
    c.font = `700 ${(S * 0.04) | 0}px monospace`; c.textAlign = 'center';
    c.fillStyle = 'rgba(220,235,255,0.55)';
    c.fillText('DOWNTOWN', this.px(0), this.py(-26));
    c.fillText('SUBURB', this.px(0), this.py(285));
    c.fillText('PARK', this.px(0), this.py(515));
  }

  /** blit the static map + stamp the player arrow and any live bosses */
  update(playerX: number, playerZ: number, facing: number, swarm: Swarm): void {
    const c = this.ctx, S = this.size;
    const ux = this.px(playerX), uy = this.py(playerZ);
    // (1) reveal the area around the player on the PERSISTENT fog mask (soft circle, accumulates)
    const R = S * 0.1, rc = this.revealCtx;
    const g = rc.createRadialGradient(ux, uy, 0, ux, uy, R);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.7, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    rc.globalCompositeOperation = 'lighten'; // overlapping reveals take MAX alpha → explored area fully opacifies (source-over asymptotes <255)
    rc.fillStyle = g; rc.beginPath(); rc.arc(ux, uy, R, 0, 7); rc.fill();
    rc.globalCompositeOperation = 'source-over';
    // (2) draw the static map, then keep ONLY the explored part (fog = the dark panel showing through)
    c.clearRect(0, 0, S, S);
    c.globalCompositeOperation = 'source-over'; c.drawImage(this.bg, 0, 0);
    c.globalCompositeOperation = 'destination-in'; c.drawImage(this.reveal, 0, 0);
    c.globalCompositeOperation = 'source-over';
    // (3) live markers on top (always shown, fog or not)
    // bosses — red pings
    for (let i = 0; i < swarm.count; i++) {
      if (swarm.type[i] !== this.bossType || swarm.hp[i] <= 0) continue;
      const x = this.px(swarm.posX[i]), y = this.py(swarm.posZ[i]);
      c.fillStyle = '#ff3355'; c.beginPath(); c.arc(x, y, S * 0.02, 0, 7); c.fill();
      c.strokeStyle = 'rgba(255,90,110,0.7)'; c.lineWidth = S * 0.008; c.beginPath(); c.arc(x, y, S * 0.034, 0, 7); c.stroke();
    }
    // player — a cyan arrow pointing where you face, in a glow ring
    const dx = Math.sin(facing), dy = Math.cos(facing), nx = -dy, ny = dx; // dir + perpendicular
    const len = S * 0.04, wid = S * 0.026;
    c.fillStyle = '#9bf8ff';
    c.beginPath();
    c.moveTo(ux + dx * len, uy + dy * len);
    c.lineTo(ux - dx * len * 0.5 + nx * wid, uy - dy * len * 0.5 + ny * wid);
    c.lineTo(ux - dx * len * 0.5 - nx * wid, uy - dy * len * 0.5 - ny * wid);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(155,248,255,0.55)'; c.lineWidth = S * 0.008;
    c.beginPath(); c.arc(ux, uy, S * 0.03, 0, 7); c.stroke();
  }
}
