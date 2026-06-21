# NEON SWARM — self-hosted backend (Phase 2b)

The leaderboard + telemetry server. Runs on a **Mac Mini behind a Cloudflare Tunnel**
for ~$0/month beyond the hardware. **The game ships with this turned OFF** — nothing
here affects the live site until you set the client endpoints (see *Going live* below).

It's deliberately tiny: **one PocketBase process** holding two collections —

- `scores` — the global daily leaderboard, keyed by `(daily_num, mode)`, top-score-wins.
- `events` — append-only anonymous product telemetry.

(The original design used Umami + Postgres + a separate Go ingest; that was dropped to
keep it to a single always-on process on an 8 GB box. Web-funnel events live in `events`.)

## Privacy posture (built in)

- **Cookieless, no device id, no PII.** Uniqueness is counted with a **server-side
  daily-rotating salted hash** of `truncated-ip + coarse-ua + UTC-day`. The raw IP is
  read from the Cloudflare header, truncated to a /24 (or /48), hashed, and **discarded
  in-request** — it is never stored. The salt lives in a RAM disk and is **rotated every
  UTC midnight**, so yesterday's hashes are irreversible.
- Anti-cheat is **statistical and accept-and-observe** (never auto-rejects legit
  high-skill runs early): tainted runs (cheats used) are rejected client- and
  server-side; everything else is accepted and *flagged* against generous ceilings.
  Tune the thresholds from real per-daily percentiles after launch.

## Run it (Mac Mini)

```sh
cd server
cp .env.example .env            # then edit TUNNEL_SECRET (a long random string)
./scripts/setup.sh              # downloads the pinned PocketBase, applies the migration
./scripts/salt-rotate.sh        # seed today's salt (also run nightly via launchd)
# start PocketBase (or install the launchd plist for KeepAlive):
PB_VER=$(cat .pbver) ./pb/pocketbase serve --http=127.0.0.1:8090
```

Then expose it with `cloudflared` (see `docs/cloudflare-tunnel.md`) so the game can reach
`https://<your-host>` — PocketBase stays bound to localhost; only the tunnel is public.

## Going live (flip the client flag — the ONLY behavior-changing change)

In the game repo, set the endpoints (either edit `src/config.ts` or build with envs):

```sh
VITE_LEADERBOARD_ENDPOINT=https://api.your-host  \
VITE_TELEMETRY_ENDPOINT=https://api.your-host/t  \
  npx vite build
```

Then redeploy. See `docs/go-live-checklist.md` for the full ordered checklist
(including flipping the CSP from Report-Only to enforce).

## Endpoints

| Client call | Route | Notes |
| --- | --- | --- |
| `submitScore` → POST | `/score` | verify tunnel secret → server anon → accept/flag → save |
| `fetchBoard` → GET | `/leaderboard/:num/:mode` | top-N, `Cache-Control: max-age=20`, parameter-free |
| `track`/flush → POST | `/t` | batched events, salted anon, append-only |

## Files

```
server/
├─ .env.example              # TUNNEL_SECRET, SALT_DIR
├─ pb/pb_migrations/*.js     # scores + events collections
├─ pb/pb_hooks/main.pb.js    # /score, /leaderboard, /t + the salted-anon helper
├─ cloudflared/config.example.yml
├─ scripts/{setup,salt-rotate}.sh
├─ launchd/*.plist           # KeepAlive PocketBase + nightly salt rotation
└─ docs/{cloudflare-tunnel,go-live-checklist,cost-scale-ops}.md
```
