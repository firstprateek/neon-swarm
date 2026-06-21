/// <reference path="../pb_data/types.d.ts" />
// NEON SWARM backend routes. Targets PocketBase ~0.22.x JSVM (routerAdd + echo
// context `c`). On other PocketBase versions the request/response API may differ
// slightly — the LOGIC (salted anon, accept-and-observe, rate-limit, board query)
// is what matters; adjust the bindings if your version's JSVM API has changed.

const ALLOW_ORIGIN = 'https://firstprateek.github.io'; // the GitHub Pages game origin

// ---- helpers ----
function cors(c) {
  const h = c.response().header();
  h.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'content-type, x-tunnel-secret');
  h.set('Vary', 'Origin');
}

function secsToUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}

// daily-rotating salted anonymous id. The raw IP is truncated then hashed with the
// day's salt (rotated nightly, kept in a RAM disk) and DISCARDED — never stored.
function anonId(c, day) {
  const ip = c.request().header.get('CF-Connecting-IP') || c.request().header.get('X-Forwarded-For') || '';
  const ua = c.request().header.get('User-Agent') || '';
  const tIp = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') /* /48 */ : ip.split('.').slice(0, 3).join('.'); /* /24 */
  const cua = /Firefox/.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Chrome/.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : 'other';
  const salt = $os.getenv('SALT_TODAY') || 'unsalted-dev';
  return $security.sha256(salt + '|' + tIp + '|' + cua + '|' + day);
}

function tunnelOk(c) {
  return c.request().header.get('x-tunnel-secret') === $os.getenv('TUNNEL_SECRET');
}

// ---- CORS preflight ----
['/score', '/t', '/leaderboard/:num/:mode'].forEach((p) =>
  routerAdd('OPTIONS', p, (c) => { cors(c); return c.noContent(204); }));

// ---- POST /score : the only write path into `scores` ----
routerAdd('POST', '/score', (c) => {
  cors(c);
  if (!tunnelOk(c)) return c.json(403, { error: 'forbidden' });
  const p = $apis.requestInfo(c).data || {};
  const day = String(p.daily_key || '');
  if (!day || !p.mode) return c.json(400, { error: 'bad_request' });
  const anon = anonId(c, day);

  // per-anon-per-(day,mode) submit cap — anti-farming backpressure
  const recent = arrayOf(new Record());
  $app.dao().recordQuery('scores')
    .andWhere($dbx.hashExp({ anon_id: anon, daily_key: day, mode: String(p.mode) }))
    .limit(30).all(recent);
  if (recent.length >= 30) return c.json(429, { error: 'rate_limited' });

  const runTime = +p.run_time || 0;
  const kps = runTime > 0 ? (p.kills || 0) / runTime : 0;
  const spm = runTime > 0 ? ((p.score || 0) / runTime) * 60 : 0;

  // ACCEPT-AND-OBSERVE: only reject tainted (cheated) runs. Everything else is
  // accepted; soft-ceiling trips just record a flag_reason for later review. Tune
  // the ceilings from real per-daily percentiles after launch — do NOT bury legit
  // high-skill runs.
  let status = 'accepted', reason = '';
  if (p.tainted) { status = 'rejected'; reason = 'tainted'; }
  else if (kps > 25) reason = 'kps_high';
  else if (spm > 600000) reason = 'spm_high';

  const col = $app.dao().findCollectionByNameOrId('scores');
  const r = new Record(col, {
    daily_key: day, daily_num: p.daily_num | 0, seed: p.seed | 0, mode: String(p.mode),
    score: p.score | 0, kills: p.kills | 0, level: p.level | 0, run_time: runTime, combo_peak: p.combo_peak | 0,
    survivor: String(p.survivor || '').slice(0, 16), handle: String(p.handle || '').slice(0, 16), anon_id: anon,
    client_ver: String(p.client_ver || ''), backend: String(p.backend || ''),
    kills_per_sec: kps, score_per_min: spm, status, flag_reason: reason,
  });
  $app.dao().saveRecord(r);
  return c.json(201, { ok: true, status });
});

// ---- GET /leaderboard/:num/:mode : cacheable, parameter-free, top-N ----
routerAdd('GET', '/leaderboard/:num/:mode', (c) => {
  cors(c);
  const num = c.pathParam('num') | 0;
  const mode = c.pathParam('mode');
  const lim = Math.min(50, Math.max(1, parseInt(c.queryParam('limit') || '10', 10)));
  const rows = arrayOf(new Record());
  // accept-and-observe: show accepted + flagged (only rejected/tainted are hidden)
  $app.dao().recordQuery('scores')
    .andWhere($dbx.exp("daily_num = {:n} AND mode = {:m} AND status != 'rejected'", { n: num, m: mode }))
    .orderBy('score DESC').limit(lim).all(rows);
  const top = rows.map((r, i) => ({
    rank: i + 1, score: r.getInt('score'), kills: r.getInt('kills'), level: r.getInt('level'),
    run_time: r.getFloat('run_time'), survivor: r.getString('survivor'), handle: r.getString('handle'),
  }));
  c.response().header().set('Cache-Control', 'public, max-age=20'); // edge-cacheable spike relief
  return c.json(200, {
    daily_num: num, mode, total: top.length, reset_in_s: secsToUtcMidnight(),
    top, your_rank: null, your_best: null,
  });
});

// ---- POST /t : append-only telemetry ingest (batched events) ----
routerAdd('POST', '/t', (c) => {
  cors(c);
  if (!tunnelOk(c)) return c.noContent(204); // never error a beacon
  const body = $apis.requestInfo(c).data || {};
  const evs = Array.isArray(body.ev) ? body.ev.slice(0, 50) : [];
  if (!evs.length) return c.noContent(204);
  const day = new Date().toISOString().slice(0, 10);
  const anon = anonId(c, day);
  const col = $app.dao().findCollectionByNameOrId('events');
  $app.dao().runInTransaction((txDao) => {
    for (const e of evs) {
      const r = new Record(col, {
        name: String(e.name || '').slice(0, 40), props: e.props || {}, sid: String(body.sid || '').slice(0, 64),
        anon_id: anon, build: String(body.build || '').slice(0, 24), client_ts: e.ts | 0,
      });
      txDao.saveRecord(r);
    }
  });
  return c.noContent(204);
});
