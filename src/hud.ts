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

let vignetteOpacity = 0;

export function update(state: GameState, enemyCount: number): void {
  hpFill.style.width = `${Math.max(0, (state.hp / state.maxHp) * 100)}%`;
  hpLabel.textContent = `${Math.ceil(Math.max(0, state.hp))}/${state.maxHp}`;
  xpFill.style.width = `${Math.min(100, (state.xp / state.xpNeed) * 100)}%`;
  levelTxt.textContent = `LV ${state.level}`;
  const mins = (state.time / 60) | 0;
  const secs = (state.time % 60) | 0;
  timerTxt.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  killsTxt.textContent = String(state.kills);
  enemiesTxt.textContent = enemyCount.toLocaleString();
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
  const pick = (u: Upgrade) => {
    window.removeEventListener('keydown', keyHandler);
    levelupOverlay.classList.add('hidden');
    onPick(u);
  };
  const keyHandler = (e: KeyboardEvent) => {
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
    card.addEventListener('click', () => pick(u));
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
