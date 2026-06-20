/**
 * Player settings, persisted to localStorage. Pure default/merge helpers
 * (validated + clamped) keep this testable; load/save wrap storage in try/catch
 * so a blocked localStorage can never break startup.
 */
export type QualityMode = 'auto' | 'ultra' | 'high' | 'medium' | 'low';

export interface Settings {
  quality: QualityMode;
  bloom: boolean;
  sound: boolean;
  volume: number; // 0..100
  fps: number;    // one of FPS_CHOICES
  avatar: number; // chosen survivor index
}

const KEY = 'neon-swarm-settings';
export const FPS_CHOICES = [60, 120, 144];
export const QUALITY_CHOICES: QualityMode[] = ['auto', 'ultra', 'high', 'medium', 'low'];

export const AVATAR_COUNT = 4;

export function defaultSettings(): Settings {
  return { quality: 'auto', bloom: true, sound: true, volume: 45, fps: 120, avatar: 0 };
}

/** validate/clamp arbitrary input into a complete Settings (used by load + tests) */
export function mergeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    quality: QUALITY_CHOICES.includes(r.quality as QualityMode) ? (r.quality as QualityMode) : d.quality,
    bloom: typeof r.bloom === 'boolean' ? r.bloom : d.bloom,
    sound: typeof r.sound === 'boolean' ? r.sound : d.sound,
    volume: typeof r.volume === 'number' && isFinite(r.volume) ? Math.max(0, Math.min(100, Math.round(r.volume))) : d.volume,
    fps: FPS_CHOICES.includes(r.fps as number) ? (r.fps as number) : d.fps,
    avatar: typeof r.avatar === 'number' && r.avatar >= 0 && r.avatar < AVATAR_COUNT ? (r.avatar | 0) : d.avatar,
  };
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
