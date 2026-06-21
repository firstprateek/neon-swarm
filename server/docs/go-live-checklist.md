# Go-live checklist — turning the backend ON

The game ships with everything OFF (all client endpoints `null`). Work top to bottom;
nothing changes for players until the **client flag flip** at the end.

## Server (Mac Mini)
- [ ] `cd server && cp .env.example .env` → set `TUNNEL_SECRET` (`openssl rand -hex 32`) and `SALT_DIR` (a RAM disk).
- [ ] `./scripts/setup.sh` → downloads the pinned PocketBase.
- [ ] `./scripts/salt-rotate.sh` → seed today's salt.
- [ ] `./scripts/run.sh` once → open `http://127.0.0.1:8090/_/`, create the admin, confirm the `scores` + `events` collections exist (migration applied).
- [ ] Smoke test the hooks locally:
      `curl -s -XPOST 127.0.0.1:8090/score -H 'x-tunnel-secret: <secret>' -H 'content-type: application/json' -d '{"daily_key":"2026-06-20","daily_num":20,"mode":"easy","seed":1,"score":100,"kills":10,"level":2,"run_time":30}'`
      → `{"ok":true,"status":"accepted"}`; then `curl 127.0.0.1:8090/leaderboard/20/easy` shows it.
- [ ] Install the launchd plists (PocketBase KeepAlive + nightly salt-rotate); `launchctl list | grep neonswarm`.

## Edge (Cloudflare Tunnel)
- [ ] Create a named tunnel; route `api.<your-host>` → `http://127.0.0.1:8090` (`cloudflared/config.example.yml`).
- [ ] Add a **Transform Rule** that sets request header `x-tunnel-secret = <TUNNEL_SECRET>` on the route (so only Cloudflare-proxied requests pass the hook check).
- [ ] Add a **Cache Rule** on `api.<host>/leaderboard/*` honoring origin Cache-Control (the 20s edge cache absorbs read spikes). WAF on; add a rate-limit rule if a free slot exists.
- [ ] Confirm CORS: the hook returns `Access-Control-Allow-Origin: https://firstprateek.github.io` — update `ALLOW_ORIGIN` in `pb_hooks/main.pb.js` if your Pages origin differs.
- [ ] `curl https://api.<host>/leaderboard/20/easy` from outside returns the board.

## Client flip (the ONLY behavior-changing deploy)
- [ ] Build with the endpoints set:
      `VITE_LEADERBOARD_ENDPOINT=https://api.<host> VITE_TELEMETRY_ENDPOINT=https://api.<host>/t npx vite build`
      (or edit the `null` literals in `src/config.ts`).
- [ ] Add the backend origins to the CSP `connect-src` and flip the `<meta>` from
      `Content-Security-Policy-Report-Only` to `Content-Security-Policy` (the CSP is
      intentionally NOT shipped while off — add it in this same commit). Boot-test
      WebGPU **and** `?webgl` for zero violations first.
- [ ] Deploy. Play a daily run → the brag card shows your global rank; `?seed` links carry `utm_source`.

## After launch
- [ ] Watch `events`/`scores` growth + the `-wal` file size; lengthen the snapshot interval if it bloats.
- [ ] Set the anti-cheat ceilings (`kps_high`/`spm_high` in `main.pb.js`) from real per-daily percentiles — keep accept-and-observe; don't bury legit high-skill runs.
- [ ] Write the GDPR legitimate-interest note for in-request IP processing before promoting widely.

## Degradation ladder (viral spike, one Mac Mini)
1. Edge cache absorbs `/leaderboard` GETs. 2. Origin per-anon submit cap (already in the hook). 3. `/t` returns 204 on overload (telemetry is lossy by design; the leaderboard is durable and never shed). 4. Global kill-switch: serve a `telemetry-config.json` with `{"enabled":false}` (client honors it). 5. Cap the percentile sweep / run it off a snapshot.
