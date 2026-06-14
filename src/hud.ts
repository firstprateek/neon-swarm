import type { GameState, Upgrade } from './state';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const hpFill = el('hp-fill');
const hpLabel = el('hp-label');
const xpFill = el('xp-fill');
const levelTxt = el('level-txt');
const timerTxt = el('timer');
const killsTxt = el('kills-txt');
const enemiesTxt = el('enemies-txt');
const fpsTxt = el('fps-txt');
const backendTxt = el('backend-txt');
const vignette = el('vignette');
const startOverlay = el('start-overlay');
const levelupOverlay = el('levelup-overlay');
const gameoverOverlay = el('gameover-overlay');
const cards = el('cards');
const goStats = el('go-stats');
const bossWrap = el('boss-wrap');
const bossFill = el('boss-fill');
const bossWarn = el('boss-warn');

let vignetteOpacity = 0;
let bossWarnTimer = 0;
let lastBossQ = -1;

// dirty-check cache: the HUD runs every frame, but the DOM (and layout)
// should only be touched when a displayed value actually changes
const last = { hpQ: -1, hpTxt: '', xpQ: -1, level: -1, secs: -1, kills: -1, enemies: -1 };

export function update(state: GameState, enemyCount: number): void {
  const hpQ = Math.round(Math.max(0, Math.min(1, state.hp / state.maxHp)) * 400);
  if (hpQ !== last.hpQ) {
    last.hpQ = hpQ;
    hpFill.style.transform = `scaleX(${hpQ / 400})`;
  }
  const hpTxt = `${Math.ceil(Math.max(0, state.hp))}/${state.maxHp}`;
  if (hpTxt !== last.hpTxt) {
    last.hpTxt = hpTxt;
    hpLabel.textContent = hpTxt;
  }
  const xpQ = Math.round(Math.min(1, state.xp / state.xpNeed) * 400);
  if (xpQ !== last.xpQ) {
    last.xpQ = xpQ;
    xpFill.style.transform = `scaleX(${xpQ / 400})`;
  }
  if (state.level !== last.level) {
    last.level = state.level;
    levelTxt.textContent = `LV ${state.level}`;
  }
  const secs = state.time | 0;
  if (secs !== last.secs) {
    last.secs = secs;
    timerTxt.textContent = `${String((secs / 60) | 0).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }
  if (state.kills !== last.kills) {
    last.kills = state.kills;
    killsTxt.textContent = String(state.kills);
  }
  if (enemyCount !== last.enemies) {
    last.enemies = enemyCount;
    enemiesTxt.textContent = enemyCount.toLocaleString();
  }
}

export function setFps(fps: number): void {
  fpsTxt.textContent = String(Math.round(fps));
}

export function setBackend(label: string): void {
  backendTxt.textContent = label;
}

export function damageFlash(): void {
  vignetteOpacity = Math.min(0.9, vignetteOpacity + 0.06);
}

export function tick(dt: number): void {
  if (vignetteOpacity > 0.001) {
    vignetteOpacity *= Math.pow(0.05, dt);
    vignette.style.opacity = vignetteOpacity.toFixed(3);
  }
  if (bossWarnTimer > 0) {
    bossWarnTimer -= dt;
    if (bossWarnTimer <= 0) bossWarn.classList.add('hidden');
  }
}

/** Show the boss HP bar at the given ratio (quantized to avoid layout churn). */
export function setBoss(hp: number, maxHp: number): void {
  bossWrap.classList.remove('hidden');
  const q = Math.round(Math.max(0, Math.min(1, hp / maxHp)) * 200);
  if (q !== lastBossQ) {
    lastBossQ = q;
    bossFill.style.transform = `scaleX(${q / 200})`;
  }
}

export function hideBoss(): void {
  if (!bossWrap.classList.contains('hidden')) {
    bossWrap.classList.add('hidden');
    lastBossQ = -1;
  }
}

/** Flash the "boss incoming" banner for a couple of seconds. */
export function bossWarning(): void {
  bossWarn.classList.remove('hidden');
  bossWarnTimer = 2.4;
}

export function showStart(onStart: () => void): void {
  const begin = () => {
    startOverlay.classList.add('hidden');
    window.removeEventListener('keydown', keyHandler);
    onStart();
  };
  const keyHandler = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.code === 'Enter') begin();
  };
  startOverlay.addEventListener('click', begin, { once: true });
  window.addEventListener('keydown', keyHandler);
}

export function showLevelUp(choices: Upgrade[], onPick: (u: Upgrade) => void): void {
  cards.innerHTML = '';
  const openedAt = performance.now();
  const pick = (u: Upgrade) => {
    window.removeEventListener('keydown', keyHandler);
    levelupOverlay.classList.add('hidden');
    onPick(u);
  };
  const keyHandler = (e: KeyboardEvent) => {
    if (e.repeat) return; // held keys must not blind-pick queued level-ups
    const n = Number(e.key);
    if (n >= 1 && n <= choices.length) pick(choices[n - 1]);
  };
  choices.forEach((u, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      `<div class="key">[${idx + 1}]</div>` +
      `<div class="name">${u.name}</div>` +
      `<div class="desc">${u.desc}</div>` +
      `<div class="stacks">owned ${u.count}/${u.max}</div>`;
    card.addEventListener('click', ev => {
      // a real double-click on a re-opened modal lands on the same spot;
      // synthetic test clicks (isTrusted=false) are exempt from the guard
      if (ev.isTrusted && performance.now() - openedAt < 150) return;
      pick(u);
    });
    cards.appendChild(card);
  });
  window.addEventListener('keydown', keyHandler);
  levelupOverlay.classList.remove('hidden');
}

export function showGameOver(state: GameState): void {
  const mins = (state.time / 60) | 0;
  const secs = (state.time % 60) | 0;
  goStats.innerHTML =
    `SURVIVED <b>${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}</b><br/>` +
    `KILLS <b>${state.kills.toLocaleString()}</b><br/>` +
    `LEVEL <b>${state.level}</b>`;
  el<HTMLButtonElement>('restart-btn').onclick = () => location.reload();
  gameoverOverlay.classList.remove('hidden');
}
