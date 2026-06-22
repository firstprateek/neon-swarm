/**
 * Player settings, persisted to localStorage. Pure default/merge helpers
 * (validated + clamped) keep this testable; load/save wrap storage in try/catch
 * so a blocked localStorage can never break startup.
 */
import { type KeyMap, defaultKeys, mergeKeys } from './keybind';
import { type Difficulty, coerceDifficulty, presetFlags } from './modes';

export type QualityMode = 'auto' | 'ultra' | 'high' | 'medium' | 'low';

export interface Settings {
  // video
  quality: QualityMode;
  bloom: boolean;
  atmosphere: boolean; // fog + drifting ash/ember particles + the split-tone/vignette grade. Default OFF (clean screen).
  fps: number;    // one of FPS_CHOICES
  zoom: number;   // camera dolly multiplier: <1 = closer (zoom in), >1 = farther (zoom out)
  // audio
  sound: boolean;
  volume: number; // 0..100 effects
  music: number;  // 0..100 music channel (reserved)
  // controls — SOURCE OF TRUTH, read directly in the fire path
  autoFire: boolean;    // ON => gun auto-fires (today). OFF => press FIRE per round.
  gunLock: boolean;     // ON => gun auto-aims nearest (today). OFF => fires toward facing.
  missileLock: boolean; // ON => missile homes + aims nearest. OFF => dumb-fire toward facing.
  // misc
  avatar: number;        // chosen survivor index
  keybinds: KeyMap;      // remappable desktop bindings
  dailyMode: Difficulty; // last-used daily preset, remembered for the mode picker
}

const KEY = 'neon-swarm-settings';
export const FPS_CHOICES = [60, 120, 144];
export const QUALITY_CHOICES: QualityMode[] = ['auto', 'ultra', 'high', 'medium', 'low'];

export const AVATAR_COUNT = 4;
export const ZOOM_MIN = 0.55; // closest (most character)
export const ZOOM_MAX = 1.9;  // farthest (most field)
export const ZOOM_DEFAULT = 1;
export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

export function defaultSettings(): Settings {
  return {
    quality: 'auto', bloom: true, atmosphere: false, fps: 120, zoom: ZOOM_DEFAULT,
    sound: true, volume: 45, music: 35,
    autoFire: true, gunLock: true, missileLock: true, // == EASY (today's behavior)
    avatar: 0, keybinds: defaultKeys(), dailyMode: 'easy',
  };
}

const clamp01 = (v: unknown, dv: number) =>
  typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : dv;
const bool = (v: unknown, dv: boolean) => (typeof v === 'boolean' ? v : dv);

/** validate/clamp arbitrary input into a complete Settings (used by load + tests) */
export function mergeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    quality: QUALITY_CHOICES.includes(r.quality as QualityMode) ? (r.quality as QualityMode) : d.quality,
    bloom: bool(r.bloom, d.bloom),
    atmosphere: bool(r.atmosphere, d.atmosphere),
    fps: FPS_CHOICES.includes(r.fps as number) ? (r.fps as number) : d.fps,
    zoom: typeof r.zoom === 'number' && isFinite(r.zoom) ? clampZoom(r.zoom) : d.zoom,
    sound: bool(r.sound, d.sound),
    volume: clamp01(r.volume, d.volume),
    music: clamp01(r.music, d.music),
    autoFire: bool(r.autoFire, d.autoFire),
    gunLock: bool(r.gunLock, d.gunLock),
    missileLock: bool(r.missileLock, d.missileLock),
    avatar: typeof r.avatar === 'number' && r.avatar >= 0 && r.avatar < AVATAR_COUNT ? (r.avatar | 0) : d.avatar,
    keybinds: mergeKeys(r.keybinds),
    dailyMode: coerceDifficulty(r.dailyMode),
  };
}

/** stamp a difficulty preset's control flags onto a settings object (in place) */
export function applyPreset(s: Settings, d: Difficulty): void {
  Object.assign(s, presetFlags(d));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return mergeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

/** governor tier index for a quality mode, or -1 for adaptive ("auto") */
export function qualityTier(mode: QualityMode): number {
  switch (mode) {
    case 'ultra': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
    default: return -1;
  }
}
