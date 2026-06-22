/**
 * Tiny WebAudio synth SFX layer. No assets — every sound is a short
 * oscillator envelope. The AudioContext is created lazily on the first user
 * gesture (browser autoplay policy), and rapid events (fire, kills) are
 * throttled so the mix never turns into machine-gun noise.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let volume = 0.45; // 0..1 master volume when unmuted
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
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = m ? 0 : volume;
}
export function isMuted(): boolean { return muted; }
export function toggleMute(): boolean { setMuted(!muted); return muted; }
export function audioReady(): boolean { return !!ctx && !!master; }

/** set master volume (0..1) */
export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master && !muted) master.gain.value = volume;
}
export function getVolume(): number { return volume; }

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

export function sfxCrit(): void {
  if (!throttle('crit', 60)) return;
  voice({ freq: 1240, slideTo: 1860, dur: 0.06, type: 'square', gain: 0.07 });
  voice({ freq: 1860, dur: 0.05, type: 'sine', gain: 0.05, delay: 0.02 });
}

// --- procedural MUSIC bed: an evolving neon drone whose brightness ramps with the on-screen threat.
// No assets, no scheduler — a detuned saw/sub pad through a slow-LFO low-pass filter (a 20-min trance
// bed). The Music slider sets its level; intensity (enemy pressure) opens the filter; a boss tenses it. ---
let musicGain: GainNode | null = null;
let musicFilter: BiquadFilterNode | null = null;
let musicNodes: OscillatorNode[] = [];
let musicVol = 0.35; // 0..1 from the Music slider
let musicOn = false;
let bossMode = false;

/** Music-slider level (0..1). Music sits UNDER the SFX (× 0.5). */
export function setMusicVolume(v: number): void {
  musicVol = Math.max(0, Math.min(1, v));
  if (ctx && musicGain) musicGain.gain.setTargetAtTime(musicOn ? musicVol * 0.5 : 0.0001, ctx.currentTime, 0.4);
}

/** start the drone (idempotent) — call after initAudio() on deploy */
export function startMusic(): void {
  if (!ctx || !master || muted || musicOn) return;
  try {
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0001;
    musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 300;
    musicFilter.Q.value = 6;
    musicFilter.connect(musicGain);
    musicGain.connect(master);
    const base = 55; // A1
    for (const [mult, det, type, g] of [[1, 0, 'sine', 0.5], [1, -5, 'sawtooth', 0.16], [1.5, 4, 'sawtooth', 0.13], [2, -3, 'triangle', 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = base * mult; o.detune.value = det;
      const vg = ctx.createGain(); vg.gain.value = g;
      o.connect(vg); vg.connect(musicFilter);
      o.start();
      musicNodes.push(o);
    }
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06; // slow breathing
    const lfoG = ctx.createGain(); lfoG.gain.value = 110;
    lfo.connect(lfoG); lfoG.connect(musicFilter.frequency); lfo.start();
    musicNodes.push(lfo);
    musicOn = true;
    setMusicVolume(musicVol);
  } catch { musicOn = false; }
}

/** threat 0..1 opens the filter (brighter = tenser); boss adds resonance + brightness */
export function setMusicIntensity(threat: number, boss = false): void {
  if (!ctx || !musicFilter || !musicOn) return;
  const t = ctx.currentTime, x = Math.max(0, Math.min(1, threat));
  musicFilter.frequency.setTargetAtTime(300 + x * (boss ? 1500 : 950), t, 1.2);
  if (boss !== bossMode) { bossMode = boss; musicFilter.Q.setTargetAtTime(boss ? 11 : 6, t, 0.8); }
}

export function stopMusic(): void {
  if (!musicOn) return;
  for (const o of musicNodes) { try { o.stop(); } catch { /* */ } }
  musicNodes = []; musicOn = false; bossMode = false;
  try { musicGain?.disconnect(); } catch { /* */ }
  musicGain = null; musicFilter = null;
}
