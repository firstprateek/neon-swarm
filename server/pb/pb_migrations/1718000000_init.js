/// <reference path="../pb_data/types.d.ts" />
// NEON SWARM backend — collections: scores (leaderboard) + events (telemetry).
// Targets PocketBase ~0.22.x JSVM. If your PocketBase version differs, the field/
// collection API may need small tweaks (see pinned version in scripts/setup.sh).
// All writes go through the /score and /t hooks — the collections themselves are
// locked (no public create/update/delete rules).

migrate((db) => {
  const dao = new Dao(db);

  // --- scores: the global daily leaderboard ---
  const scores = new Collection({
    name: 'scores',
    type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    schema: [
      { name: 'daily_key', type: 'text', required: true },   // YYYY-MM-DD (UTC)
      { name: 'daily_num', type: 'number', required: true },
      { name: 'seed', type: 'number', required: true },
      { name: 'mode', type: 'text', required: true },         // easy | medium | hard
      { name: 'score', type: 'number', required: true },
      { name: 'kills', type: 'number', required: true },
      { name: 'level', type: 'number', required: true },
      { name: 'run_time', type: 'number', required: true },
      { name: 'combo_peak', type: 'number' },
      { name: 'survivor', type: 'text' },
      { name: 'handle', type: 'text' },                       // chosen display name (<=16)
      { name: 'anon_id', type: 'text', required: true },      // salted daily hash, NOT reversible
      { name: 'client_ver', type: 'text' },
      { name: 'backend', type: 'text' },
      { name: 'kills_per_sec', type: 'number' },
      { name: 'score_per_min', type: 'number' },
      { name: 'status', type: 'select', required: true, options: { maxSelect: 1, values: ['accepted', 'flagged', 'rejected'] } },
      { name: 'flag_reason', type: 'text' },
    ],
    indexes: [
      'CREATE INDEX ix_scores_daily ON scores (daily_num, mode, status, score DESC)',
      'CREATE INDEX ix_scores_anon  ON scores (anon_id, daily_key, mode)',
    ],
  });
  dao.saveCollection(scores);

  // --- events: append-only anonymous telemetry ---
  const events = new Collection({
    name: 'events',
    type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    schema: [
      { name: 'name', type: 'text', required: true },
      { name: 'props', type: 'json' },     // anonymous, low-cardinality only (coarsened client-side)
      { name: 'sid', type: 'text' },        // per-page-load session (in-memory client-side, not a tracker)
      { name: 'anon_id', type: 'text' },     // salted daily hash
      { name: 'build', type: 'text' },
      { name: 'client_ts', type: 'number' },
    ],
    indexes: ['CREATE INDEX ix_events_name ON events (name, created)'],
  });
  dao.saveCollection(events);
}, (db) => {
  const dao = new Dao(db);
  dao.deleteCollection(dao.findCollectionByNameOrId('scores'));
  dao.deleteCollection(dao.findCollectionByNameOrId('events'));
});
