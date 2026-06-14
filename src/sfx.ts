/**
 * Tiny WebAudio synth SFX layer. No assets — every sound is a short
 * oscillator envelope. The AudioContext is created lazily on the first user
 * gesture (browser autoplay policy), and rapid events (fire, kills) are
 * throttled so the mix never turns into machine-gun noise.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const VOLUME = 0.45;
const lastPlay: Record<string, number> = {};

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** create/resume the context — must be called from a user gesture (e.g. start click) */
export function initAudio(): void {
  try {
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    master.connect(ctx.destination);
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = m ? 0 : VOLUME;
}
export function isMuted(): boolean { return muted; }
export function toggleMute(): boolean { setMuted(!muted); return muted; }
export function audioReady(): boolean { return !!ctx && !!master; }

/** true if enough time passed since this name last played */
function throttle(name: string, ms: number): boolean {
  const t = clock();
  if (t - (lastPlay[name] ?? -1e9) < ms) return false;
  lastPlay[name] = t;
  return true;
}

interface Voice {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
  delay?: number;
}

function voice(v: Voice): void {
  if (!ctx || !master || muted) return;
  try {
    const t = ctx.currentTime + (v.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = v.type ?? 'square';
    osc.frequency.setValueAtTime(v.freq, t);
    if (v.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.slideTo), t + v.dur);
    const peak = v.gain ?? 0.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + v.dur + 0.03);
  } catch {
    /* never let audio break the game loop */
  }
}

// --- game SFX ---
export function sfxFire(): void {
  if (!throttle('fire', 70)) return;
  voice({ freq: 760, slideTo: 480, dur: 0.05, type: 'square', gain: 0.05 });
}
export function sfxKill(): void {
  if (!throttle('kill', 45)) return;
  voice({ freq: 200, slideTo: 90, dur: 0.07, type: 'triangle', gain: 0.06 });
}
export function sfxPickup(): void {
  if (!throttle('pickup', 35)) return;
  voice({ freq: 540, slideTo: 1080, dur: 0.07, type: 'sine', gain: 0.07 });
}
export function sfxLevelUp(): void {
  voice({ freq: 523, dur: 0.12, type: 'sine', gain: 0.13 });
  voice({ freq: 659, dur: 0.12, type: 'sine', gain: 0.13, delay: 0.08 });
  voice({ freq: 784, dur: 0.18, type: 'sine', gain: 0.14, delay: 0.16 });
}
export function sfxHurt(): void {
  if (!throttle('hurt', 180)) return;
  voice({ freq: 140, slideTo: 70, dur: 0.12, type: 'sawtooth', gain: 0.11 });
}
export function sfxBossWarn(): void {
  voice({ freq: 110, slideTo: 165, dur: 0.5, type: 'sawtooth', gain: 0.16 });
  voice({ freq: 82, dur: 0.6, type: 'square', gain: 0.12, delay: 0.05 });
}
export function sfxBossDie(): void {
  voice({ freq: 330, slideTo: 50, dur: 0.6, type: 'sawtooth', gain: 0.2 });
  voice({ freq: 160, slideTo: 40, dur: 0.7, type: 'square', gain: 0.15, delay: 0.04 });
}
export function sfxDeath(): void {
  voice({ freq: 440, slideTo: 60, dur: 0.9, type: 'sawtooth', gain: 0.2 });
}
