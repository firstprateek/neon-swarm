/**
 * Remappable keyboard bindings (desktop). Pure helpers, mirrors settings.ts so
 * mergeKeys() can validate persisted input and never leave an action unbound.
 * Pause (Escape) and mute (KeyM) stay FIXED and are not remappable; arrows are a
 * fixed secondary movement set.
 */
export type KeyAction = 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight' | 'fire' | 'missile' | 'nuke' | 'dash';
export type KeyMap = Record<KeyAction, string>; // value = KeyboardEvent.code

export const KEY_ACTIONS: KeyAction[] = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'fire', 'missile', 'nuke', 'dash'];
export const ACTION_LABELS: Record<KeyAction, string> = {
  moveUp: 'MOVE UP', moveDown: 'MOVE DOWN', moveLeft: 'MOVE LEFT', moveRight: 'MOVE RIGHT',
  fire: 'FIRE', missile: 'MISSILE', nuke: 'NUKE', dash: 'DASH',
};

export function defaultKeys(): KeyMap {
  return {
    moveUp: 'KeyW', moveDown: 'KeyS', moveLeft: 'KeyA', moveRight: 'KeyD',
    fire: 'Space', missile: 'KeyE', nuke: 'KeyQ', dash: 'ShiftLeft',
  };
}

const RESERVED = new Set(['Escape', 'KeyM']); // pause + mute stay fixed
const isArrow = (c: string) => c.startsWith('Arrow'); // arrows are fixed secondary-move

export function isBindable(code: string): boolean {
  return !!code && code !== 'Unidentified' && !RESERVED.has(code) && !isArrow(code);
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'SPACE';
  if (code === 'ShiftLeft') return 'L-SHIFT';
  if (code === 'ShiftRight') return 'R-SHIFT';
  return code.toUpperCase();
}

export function mergeKeys(raw: unknown): KeyMap {
  const d = defaultKeys();
  const out: KeyMap = { ...d };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const a of KEY_ACTIONS) {
      const c = r[a];
      if (typeof c === 'string' && isBindable(c)) out[a] = c;
    }
  }
  return repairCollisions(out, d);
}

/**
 * First action (in KEY_ACTIONS order) keeps a contested code; later ones reset to
 * their default, and if a default still collides, to the first free default code —
 * never leave an action unbound.
 */
export function repairCollisions(map: KeyMap, d: KeyMap): KeyMap {
  const seen = new Set<string>();
  for (const a of KEY_ACTIONS) {
    if (!seen.has(map[a])) { seen.add(map[a]); continue; }
    let cand = d[a];
    if (seen.has(cand)) cand = Object.values(d).find(c => !seen.has(c)) ?? d[a];
    map[a] = cand; seen.add(cand);
  }
  return map;
}

export function resolveAction(map: KeyMap, code: string): KeyAction | null {
  for (const a of KEY_ACTIONS) if (map[a] === code) return a;
  return null;
}

export function isDown(map: KeyMap, held: Set<string>, a: KeyAction): boolean {
  return held.has(map[a]);
}
