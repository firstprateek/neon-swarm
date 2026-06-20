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
const pauseOverlay = el('pause-overlay');
const avatarOverlay = el('avatar-overlay');
const avatarCards = el('avatar-cards');
const bossWrap = el('boss-wrap');
const bossFill = el('boss-fill');
const bossWarn = el('boss-warn');
const scoreTxt = el('score');
const comboTxt = el('combo');
const floatersEl = el('floaters');
const toastEl = el('toast');
const flashEl = el('flash');
const abMissile = el('ab-missile');
const abNuke = el('ab-nuke');
const abDash = el('ab-dash');

let vignetteOpacity = 0;
let bossWarnTimer = 0;
let lastBossQ = -1;
let toastTimer = 0;
let flashOpacity = 0;
const lastAb = { m: -1, n: -1, d: -1 };

// --- pooled floating text (e.g. boss damage numbers) ---
interface Floater { el: HTMLSpanElement; x: number; y: number; life: number; maxLife: number }
const floaters: Floater[] = [];
const FLOATER_POOL = 18;

function getFloater(): Floater {
  for (const f of floaters) if (f.life <= 0) return f;
  if (floaters.length < FLOATER_POOL) {
    const span = document.createElement('span');
    span.className = 'floater';
    floatersEl.appendChild(span);
    const f: Floater = { el: span, x: 0, y: 0, life: 0, maxLife: 1 };
    floaters.push(f);
    return f;
  }
  let oldest = floaters[0];
  for (const f of floaters) if (f.life < oldest.life) oldest = f;
  return oldest;
}

/** Spawn a short-lived number/text that floats up and fades at screen (x,y). */
export function floatText(x: number, y: number, text: string, color = '#ffe24a'): void {
  const f = getFloater();
  f.x = x; f.y = y; f.life = f.maxLife = 0.85;
  f.el.textContent = text;
  f.el.style.color = color;
  f.el.style.opacity = '1';
  f.el.style.display = 'block';
  f.el.style.transform = `translate(${x}px, ${y}px)`;
}

function updateFloaters(dt: number): void {
  for (const f of floaters) {
    if (f.life <= 0) continue;
    f.life -= dt;
    if (f.life <= 0) { f.el.style.display = 'none'; continue; }
    f.y -= 46 * dt; // drift up (px/s)
    const a = f.life / f.maxLife;
    f.el.style.opacity = a.toFixed(2);
    f.el.style.transform = `translate(${f.x}px, ${f.y}px) scale(${1 + (1 - a) * 0.35})`;
  }
}

/** count of currently-visible floaters (for tests) */
export function activeFloaters(): number {
  return floaters.reduce((n, f) => n + (f.life > 0 ? 1 : 0), 0);
}

// dirty-check cache: the HUD runs every frame, but the DOM (and layout)
// should only be touched when a displayed value actually changes
const last = { hpQ: -1, hpTxt: '', xpQ: -1, level: -1, secs: -1, kills: -1, enemies: -1, score: -1, comboShown: false, mult: '' };

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
  if (state.score !== last.score) {
    last.score = state.score;
    scoreTxt.textContent = state.score.toLocaleString();
  }
  // combo multiplier: show + pulse while a combo is alive, hide when it lapses
  const comboLive = state.comboTimer > 0 && state.combo >= 2;
  if (comboLive) {
    const mult = '×' + (1 + Math.min(state.combo, 40) * 0.1).toFixed(1);
    if (mult !== last.mult) {
      last.mult = mult;
      comboTxt.textContent = mult;
      // retrigger the pulse animation on each combo increment
      comboTxt.classList.remove('pulse');
      void comboTxt.offsetWidth;
      comboTxt.classList.add('pulse');
    }
    if (!last.comboShown) { last.comboShown = true; comboTxt.classList.remove('hidden'); }
  } else if (last.comboShown) {
    last.comboShown = false;
    last.mult = '';
    comboTxt.classList.add('hidden');
    comboTxt.classList.remove('pulse');
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
  updateFloaters(dt);
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer < 0.4) toastEl.style.opacity = Math.max(0, toastTimer / 0.4).toFixed(2);
    if (toastTimer <= 0) toastEl.classList.add('hidden');
  }
  if (flashOpacity > 0.005) {
    flashOpacity *= Math.pow(0.0015, dt);
    flashEl.style.opacity = flashOpacity.toFixed(3);
    if (flashOpacity <= 0.005) flashEl.classList.add('hidden');
  }
}

/** fullscreen flash (nuke, big events) that fades out */
export function flash(color = '#ffffff', peak = 0.6): void {
  flashEl.style.background = color;
  flashOpacity = peak;
  flashEl.style.opacity = peak.toFixed(3);
  flashEl.classList.remove('hidden');
}

/** ability HUD: missile/nuke counts + dash readiness (dirty-checked) */
export function setAbilities(missiles: number, nukes: number, dashReady: boolean): void {
  if (missiles !== lastAb.m) {
    lastAb.m = missiles;
    abMissile.querySelector('b')!.textContent = String(missiles);
    abMissile.classList.toggle('empty', missiles === 0);
  }
  if (nukes !== lastAb.n) {
    lastAb.n = nukes;
    abNuke.querySelector('b')!.textContent = String(nukes);
    abNuke.classList.toggle('empty', nukes === 0);
  }
  const d = dashReady ? 1 : 0;
  if (d !== lastAb.d) {
    lastAb.d = d;
    abDash.querySelector('b')!.textContent = dashReady ? 'READY' : '·····';
    abDash.classList.toggle('ready', dashReady);
    abDash.classList.toggle('empty', !dashReady);
  }
}

/** brief centered message (cheat feedback, notifications) */
export function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.style.opacity = '1';
  toastEl.classList.remove('hidden');
  toastTimer = 1.6;
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

export interface StartConfig {
  /** non-null => arrived via a ?seed= challenge link (skip the daily/free choice) */
  challengeSeed: number | null;
  daily: { num: number; best: number };
  onDaily: () => void;
  onFreePlay: () => void;
}

/** title screen: pick DAILY (global same-seed run) or FREE PLAY; challenge links accept-and-go */
export function showStart(cfg: StartConfig): void {
  const dailyBtn = el<HTMLButtonElement>('daily-btn');
  const freeBtn = el<HTMLButtonElement>('freeplay-btn');
  const hint = el('start-hint');
  const main = (b: HTMLElement) => b.querySelector('.mode-main') as HTMLElement;
  const sub = (b: HTMLElement) => b.querySelector('.mode-sub') as HTMLElement;
  let done = false;
  const choose = (fn: () => void) => {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', keyHandler);
    startOverlay.classList.add('hidden');
    fn();
  };
  const keyHandler = (e: KeyboardEvent) => {
    if (cfg.challengeSeed != null) {
      if (e.code === 'Space' || e.code === 'Enter') choose(cfg.onFreePlay);
    } else if (e.code === 'KeyF') {
      choose(cfg.onFreePlay);
    } else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyD') {
      choose(cfg.onDaily); // Enter = the headline (daily) mode
    }
  };

  if (cfg.challengeSeed != null) {
    // challenge link: one accept button, drop straight into their exact seed
    dailyBtn.classList.add('hidden');
    main(freeBtn).textContent = '⚔ ACCEPT CHALLENGE';
    sub(freeBtn).textContent = `seed #${cfg.challengeSeed} · beat their run`;
    freeBtn.onclick = () => choose(cfg.onFreePlay);
    hint.textContent = 'ENTER / CLICK TO DEPLOY';
  } else {
    dailyBtn.classList.remove('hidden');
    main(dailyBtn).textContent = '☀ DAILY CHALLENGE';
    sub(dailyBtn).textContent =
      cfg.daily.best > 0
        ? `Daily #${cfg.daily.num} · your best ${cfg.daily.best.toLocaleString()}`
        : `Daily #${cfg.daily.num} · everyone, same run`;
    dailyBtn.onclick = () => choose(cfg.onDaily);
    main(freeBtn).textContent = '▶ FREE PLAY';
    sub(freeBtn).textContent = 'fresh random run';
    freeBtn.onclick = () => choose(cfg.onFreePlay);
    hint.textContent = 'D DAILY · F FREE PLAY';
  }
  window.addEventListener('keydown', keyHandler);
  startOverlay.classList.remove('hidden');
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

export interface AvatarCard { name: string; trait: string; skin: number; clothes: number; legs: number; accent: number }

/** survivor select screen: 4 cards w/ CSS-silhouette thumbnails, 1-4 + arrows + Enter */
export function showAvatarSelect(avatars: AvatarCard[], current: number, onPick: (i: number) => void): void {
  let sel = Math.max(0, Math.min(avatars.length - 1, current));
  avatarCards.innerHTML = '';
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  const els = avatars.map((a, i) => {
    const card = document.createElement('div');
    card.className = 'avatar-card';
    card.innerHTML =
      `<div class="avatar-sil"><div style="background:${hex(a.skin)}"></div><div style="background:${hex(a.clothes)}"></div><div style="background:${hex(a.legs)}"></div></div>` +
      `<div class="avatar-name" style="color:${hex(a.accent)}">${a.name}</div>` +
      `<div class="avatar-trait">${a.trait}</div>`;
    card.addEventListener('click', () => { sel = i; commit(); });
    avatarCards.appendChild(card);
    return card;
  });
  const highlight = () => els.forEach((c, i) => c.classList.toggle('selected', i === sel));
  const commit = () => {
    window.removeEventListener('keydown', keyHandler);
    avatarOverlay.classList.add('hidden');
    onPick(sel);
  };
  const keyHandler = (e: KeyboardEvent) => {
    const n = Number(e.key);
    if (n >= 1 && n <= avatars.length) { sel = n - 1; highlight(); }
    else if (e.code === 'ArrowRight') { sel = (sel + 1) % avatars.length; highlight(); }
    else if (e.code === 'ArrowLeft') { sel = (sel - 1 + avatars.length) % avatars.length; highlight(); }
    else if (e.code === 'Enter' || e.code === 'Space') commit();
  };
  window.addEventListener('keydown', keyHandler);
  highlight();
  avatarOverlay.classList.remove('hidden');
}

export function showPause(): void { pauseOverlay.classList.remove('hidden'); }
export function hidePause(): void { pauseOverlay.classList.add('hidden'); }
export function isPauseOpen(): boolean { return !pauseOverlay.classList.contains('hidden'); }

export interface RunInfo {
  survivor: string;
  seed: number;
  shareUrl: string;
  /** present when the run was today's Daily Challenge */
  daily?: { num: number; best: number; isBest: boolean } | null;
}

export function showGameOver(state: GameState, info: RunInfo): void {
  const mins = (state.time / 60) | 0;
  const secs = (state.time % 60) | 0;
  const time = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const peakMult = (1 + Math.min(state.comboPeak, 40) * 0.1).toFixed(1);
  const daily = info.daily;

  el('brag-label').textContent = daily ? `☀ DAILY #${daily.num}` : 'NEON SWARM';
  el('brag-score').textContent = state.score.toLocaleString();
  el('brag-sub').textContent = `${info.survivor} · PEAK ×${peakMult}`;

  const dailyEl = el('brag-daily');
  if (daily) {
    dailyEl.classList.remove('hidden');
    dailyEl.classList.toggle('newbest', daily.isBest);
    dailyEl.textContent = daily.isBest ? '★ NEW DAILY BEST!' : `DAILY BEST ${daily.best.toLocaleString()}`;
  } else {
    dailyEl.classList.add('hidden');
  }

  goStats.className = 'brag-grid';
  goStats.innerHTML =
    `<div>SURVIVED <b>${time}</b></div>` +
    `<div>KILLS <b>${state.kills.toLocaleString()}</b></div>` +
    `<div>LEVEL <b>${state.level}</b></div>` +
    `<div>PEAK COMBO <b>${state.comboPeak}</b></div>`;
  el('brag-seed').textContent = `SEED #${info.seed}`;

  const shareText = daily
    ? `I scored ${state.score.toLocaleString()} on NEON SWARM ☀ Daily #${daily.num} 🧟 — same run for everyone today, can you beat me? ${info.shareUrl}`
    : `I scored ${state.score.toLocaleString()} in NEON SWARM 🧟 — same seed, can you beat my run? ${info.shareUrl}`;
  const shareBtn = el<HTMLButtonElement>('share-btn');
  shareBtn.textContent = '⚔ CHALLENGE A FRIEND';
  shareBtn.onclick = async () => {
    try {
      const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
      if (nav.share) {
        await nav.share({ text: shareText });
      } else {
        await navigator.clipboard.writeText(shareText);
        shareBtn.textContent = '✓ LINK COPIED!';
      }
    } catch {
      try { await navigator.clipboard.writeText(shareText); shareBtn.textContent = '✓ LINK COPIED!'; } catch { /* ignore */ }
    }
  };
  el<HTMLButtonElement>('restart-btn').onclick = () => location.reload();
  gameoverOverlay.classList.remove('hidden');
}
