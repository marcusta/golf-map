# VPS serve-mode runbook

Operating the serve half of the deploy split: install, run, publish to, back up
and troubleshoot a `SERVER_MODE=serve` box. Design and rationale live in
[feature-local-builder-vps-serve.md](../feature-local-builder-vps-serve.md); this
document is the one you follow with a terminal open.

Two boxes, one codebase:

| | **builder** (local Mac) | **serve** (VPS) |
|---|---|---|
| `SERVER_MODE` | `builder` (default) | `serve` |
| Owns | raw lidar/ortho, `golfpipe`, SAM/LaMa models, the authoring UI | published tiles, content rows, analysis DEM |
| Mounts | every API | runtime APIs + `/tiles` + `POST /api/ingest/site` |
| Web UI | full builder | builder affordances hidden (`/api/meta` → `mode`) |
| Data flow | `bun run publish <siteId>` → | ingest + atomic swap |

Nothing on the VPS is authored. Everything except **user rows** (`app.sqlite`)
is regenerable from the builder, which is what makes the backup story small.

---

## 1. Prerequisites

- A small VPS (2 vCPU / 2 GB is plenty; disk ≈ 150 MB per published site — see §9).
- [Bun](https://bun.sh) installed system-wide (`/usr/local/bin/bun`).
- A DNS name pointing at the box, if you want TLS (recommended).
- The repo checked out at `/srv/golf-map`, owned by a dedicated unprivileged user:

```sh
sudo useradd --system --home /srv/golf-map --shell /usr/sbin/nologin golfmap
sudo mkdir -p /srv/golf-map /srv/golf-map-data
sudo chown -R golfmap:golfmap /srv/golf-map /srv/golf-map-data
sudo -u golfmap git clone <repo-url> /srv/golf-map
```

Install dependencies and build the web app (both entries — desktop and mobile):

```sh
cd /srv/golf-map/server && sudo -u golfmap bun install
cd /srv/golf-map/web    && sudo -u golfmap bun install && sudo -u golfmap bun run build
```

`web/dist/` now holds `index.html`, `mobile.html` and `assets/`. The server
serves it in serve mode (§4).

## 2. Environment file

`/etc/golf-map.env`, mode `0640`, owner `root:golfmap` (it holds the publish
token):

```ini
SERVER_MODE=serve
PORT=3000
LOG_LEVEL=info

# Data layout. DATA_DIR holds tiles/, dem/, tile-archives/, incoming/.
DATA_DIR=/srv/golf-map-data
DB_PATH=/srv/golf-map-data/app.sqlite
SESSION_DB_PATH=/srv/golf-map-data/sessions.sqlite
OBS_DB_PATH=/srv/golf-map-data/obs.sqlite
WEB_DIST_DIR=/srv/golf-map/web/dist

# Publish auth — identical value on the builder. See §6.
PUBLISH_TOKEN=<48 random bytes, base64>

# Ingest uploads a 60–80 MB bundle in ONE request. Both of these are far below
# that by default (1 MB body, 30 s timeout) and MUST be raised, or publish
# fails with a 413/timeout that looks like a network fault.
BODY_LIMIT=268435456
REQUEST_TIMEOUT=900000

# Tiles are fetched by MapLibre as WebGL textures; the default same-origin
# policy blocks that when the web app is served from another origin. Leave the
# default if bun/Caddy serve the app from the same origin as the API.
# CROSS_ORIGIN_RESOURCE_POLICY=cross-origin
# CORS_ORIGIN=https://golf.example.com

# Observability retention (see §8).
TRACE_TTL_DAYS=3
OBS_MAX_MB=64
```

## 3. systemd unit

`/etc/systemd/system/golf-map.service`:

```ini
[Unit]
Description=golf-map API (serve mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=golfmap
Group=golfmap
WorkingDirectory=/srv/golf-map/server
EnvironmentFile=/etc/golf-map.env
ExecStart=/usr/local/bin/bun main.ts
Restart=on-failure
RestartSec=2
# Ingest writes a multi-hundred-MB bundle to DATA_DIR/incoming and extracts it.
TimeoutStopSec=30
KillSignal=SIGINT

# Hardening — the process needs nothing outside its data dir.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/srv/golf-map-data
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now golf-map
journalctl -u golf-map -f
curl -s localhost:3000/api/meta   # → {"…","mode":"serve"}
```

`mode: "serve"` in that response is the single check that the box is in the
right half of the split — the web UI reads exactly the same field to decide
which affordances to render.

## 4. Serving the web app

Two supported setups. **Caddy in front is recommended** (automatic TLS, HTTP/2,
compression); the built-in static server exists so the box also works with
nothing in front of it.

### (a) Built-in (bun)

Nothing to configure: in serve mode the server mounts
[`server/services/static.ts`](../../server/services/static.ts) at `/` after
`/api` and `/tiles`, serving `WEB_DIST_DIR` with two SPA fallbacks —
`/m` and `/m/*` → `mobile.html`, everything else → `index.html`. Hashed
`/assets/*` are `immutable`, HTML is `no-cache`, `/api` and `/tiles` never fall
through to the app shell, and a missing build answers 503 telling you to run
`bun run build`.

### (b) Caddy in front (recommended)

`/etc/caddy/Caddyfile` — the same routing, plus TLS:

```caddy
golf.example.com {
	encode zstd gzip

	# API and tiles go to bun. Must come first: these prefixes must never be
	# answered by the static file server or the SPA fallback.
	handle /api/* {
		# Publish bundles are 60–80 MB in one request.
		request_body {
			max_size 256MB
		}
		reverse_proxy localhost:3000 {
			flush_interval -1
			transport http {
				read_timeout 15m
				write_timeout 15m
			}
		}
	}
	handle /tiles/* {
		reverse_proxy localhost:3000
	}

	# Static web build, with the two SPA entries.
	root * /srv/golf-map/web/dist

	@mobile path /m /m/*
	handle @mobile {
		try_files {path} /mobile.html
		file_server
	}

	handle {
		try_files {path} /index.html
		file_server
	}

	# Cache policy is decided on the REQUEST path, before try_files rewrites
	# it — so matching /index.html would miss every SPA-fallback URL
	# (/course/<id>, /m/round/<id>), which is most of the app's traffic.
	# Match the hashed prefix, and treat everything else as a document.
	@hashed path /assets/*
	header @hashed Cache-Control "public, max-age=31536000, immutable"

	@doc not path /assets/* /api/* /tiles/*
	header @doc Cache-Control "no-cache"

	log {
		output file /var/log/caddy/golf-map.log
	}
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

With Caddy terminating TLS, bun only needs to listen on localhost — add
`HOSTNAME=127.0.0.1` if your firewall does not already cover port 3000.

## 5. Users

Sessions are cookie-based and local to the box; publish does **not** carry user
rows (§5 of the design doc — user tables are VPS-owned). Create accounts on the
VPS itself:

```sh
cd /srv/golf-map/server
sudo -u golfmap env DB_PATH=/srv/golf-map-data/app.sqlite bun db/create-user.ts <username>
```

Tile routes stay unauthenticated (map clients fetch them without cookies), as on
the builder.

## 6. PUBLISH_TOKEN provisioning

`POST /api/ingest/site` is the only write path into the box that is not a
session, so it is bearer-authenticated with a shared secret. A blank or missing
`PUBLISH_TOKEN` on the VPS rejects every publish (fail closed) — it is not a
"no auth" mode.

Generate once, on either box:

```sh
openssl rand -base64 48
```

**On the VPS**: put it in `/etc/golf-map.env` (§2), then
`sudo systemctl restart golf-map`. Keep the file `0640 root:golfmap`.

**On the builder**: export it alongside the target URL — a shell profile, a
direnv `.envrc`, or a one-off on the publish command line:

```sh
export PUBLISH_URL=https://golf.example.com
export PUBLISH_TOKEN=<same value>
```

Rotation: generate a new value, update the VPS env file, restart, then update
the builder. A publish attempted in between fails with 401 and changes nothing —
the ingest transaction never starts. Never commit the token; never paste it into
a course/site field where it would end up in a bundle.

## 7. Publish → ingest

Run from the **builder**, with the map already built for the site:

```sh
cd server
bun run publish <siteId>                 # default ortho cap z19, uploads
bun run publish <siteId> --ortho-maxzoom 18
bun run publish <siteId> --no-upload     # build the bundle only, inspect it
bun run publish <siteId> --full-dem      # ship the full DEM (see below)
```

What happens, in order:

1. **Preflight** — site exists, tile manifest present, no map-build job running,
   warnings for unbaked ortho patches.
2. **Analysis DEM** — builds `dem-analysis.tif` (greens at 0.5 m + 1 m elsewhere,
   one tiled deflate GeoTIFF — no overviews, nothing renders it) when stale,
   from `dem-edited.tif` if terrain edits exist,
   else `dem.tif`. Cached at `sources/<siteId>/dem-analysis.tif`. If the pipeline
   is unavailable the publish does **not** fail: it warns and ships the full DEM
   instead (a bigger bundle, same behaviour on the VPS). `--full-dem` forces that
   path deliberately.
3. **Pack** — `tar.zst` with `meta.json`, `content/<table>.jsonl`, the tile trees
   (ortho capped, manifest rewritten to match) and the DEM.
4. **Upload** — one streamed `POST /api/ingest/site` with the bearer token.
5. **Ingest (VPS)** — staged extract, atomic tile swap, transactional content
   upsert/delete, `course_assets` rewrite, archive-cache invalidation.
6. The ingest report is printed on the builder: rows per table, tile count,
   bytes, swap result.

Verify from the VPS afterwards:

```sh
curl -s localhost:3000/api/courses | head -c 400
curl -sI localhost:3000/tiles/<siteId>/ortho/16/…/….png | head -1
```

Failure modes worth recognising:

| Symptom | Cause | Action |
|---|---|---|
| `401` from ingest | token mismatch / blank on VPS | §6 |
| `413` or a stalled upload | `BODY_LIMIT` / `REQUEST_TIMEOUT` (or Caddy's `max_size`) too small | §2, §4 |
| `409` with a blocker list | a published delete would orphan user rows (rounds referencing a removed hole) | fix on the builder, or keep the hole; the ingest rolled back — nothing changed |
| Publish warns "analysis DEM … full DEM" | pipeline venv missing/broken on the builder | fine to ship; fix `MAP_PIPELINE_DIR`/`MAP_PIPELINE_PYTHON` before the next publish |
| Course visible but no tiles | client requesting above the ortho cap | check the published `manifest.json` maxzoom |

Rollback is a re-publish: the previous bundle from the builder is the source of
truth, and every ingest is a full replace for that site.

## 8. Observability retention

The framework prunes raw `traces` hourly (`TRACE_TTL_DAYS`, default 3). It does
**not** prune `metrics_rollups`, `analytics_events` or `error_reports`, which is
why an untended `obs.sqlite` reaches tens of megabytes. Rotate them with
[`server/scripts/obs-rotate.ts`](../../server/scripts/obs-rotate.ts): an age
prune per table, an optional hard size cap for bursts, then VACUUM + a
truncating WAL checkpoint so the space actually returns to the filesystem.

```sh
cd /srv/golf-map/server
sudo -u golfmap env OBS_DB_PATH=/srv/golf-map-data/obs.sqlite \
  bun scripts/obs-rotate.ts --max-mb 64
```

Daily via systemd — `/etc/systemd/system/golf-map-obs-rotate.service`:

```ini
[Unit]
Description=golf-map obs.sqlite rotation

[Service]
Type=oneshot
User=golfmap
Group=golfmap
WorkingDirectory=/srv/golf-map/server
EnvironmentFile=/etc/golf-map.env
ExecStart=/usr/local/bin/bun scripts/obs-rotate.ts --max-mb 64
```

`/etc/systemd/system/golf-map-obs-rotate.timer`:

```ini
[Unit]
Description=Daily golf-map obs.sqlite rotation

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl enable --now golf-map-obs-rotate.timer
systemctl list-timers golf-map-obs-rotate
```

Defaults: traces 3 days, everything else 30 days. Flags: `--trace-days`,
`--event-days`, `--rollup-days`, `--error-days`, `--max-mb`, `--db`. Safe to run
against the live server (bounded DELETEs; VACUUM holds a write lock for well
under a second at this size). VACUUM needs that lock exclusively, so on a busy
box the run can still fail with `SQLITE_BUSY` — it is not destructive and the
deletes already committed, so just run it again (the timer's next fire is
enough). If the report says the size cap was hit, lower the TTLs rather than
raising the cap — it means retention, not the cap, is wrong.

## 9. Backups

The only unrecoverable data on the VPS is **user rows in `app.sqlite`** (users,
rounds, shots, calibrations, plans) plus `sessions.sqlite` (cheap to lose — it
just logs everyone out). Tiles, content rows and the analysis DEM come back with
one `bun run publish` per site. `obs.sqlite` is disposable.

### (a) Litestream (continuous, recommended)

`/etc/litestream.yml`:

```yaml
dbs:
  - path: /srv/golf-map-data/app.sqlite
    replicas:
      - type: s3
        bucket: golf-map-backups
        path: app
        endpoint: <s3-compatible endpoint>
        access-key-id: <key>
        secret-access-key: <secret>
        retention: 720h
```

```sh
sudo systemctl enable --now litestream
litestream databases            # confirm it is watching
litestream generations /srv/golf-map-data/app.sqlite
```

Restore onto a fresh box:

```sh
sudo systemctl stop golf-map
sudo -u golfmap litestream restore -o /srv/golf-map-data/app.sqlite s3://golf-map-backups/app
sudo systemctl start golf-map
```

Then re-publish each site from the builder to refill tiles/content.

### (b) Nightly snapshot (no object storage)

`sqlite3 .backup` is safe against a live WAL database — do not `cp` the file.

```sh
sudo -u golfmap sqlite3 /srv/golf-map-data/app.sqlite \
  ".backup '/srv/golf-map-data/backups/app-$(date +%F).sqlite'"
find /srv/golf-map-data/backups -name 'app-*.sqlite' -mtime +14 -delete
```

Wrap that in a `oneshot` service + daily timer exactly as in §8, and copy the
result offsite (`rsync`/`rclone`) — a backup that never leaves the box is not a
backup.

## 10. Disk budget & housekeeping

Per published site, ortho capped at z19: tiles ~70 MB, one cached bundle tar
~55 MB, analysis DEM ~8 MB, content rows a few MB — **~135 MB worst case**. Ten
sites ≈ 1.4 GB.

```sh
du -sh /srv/golf-map-data/*
```

- `incoming/` should be empty between publishes; the ingest deletes its upload
  in a `finally`. Leftovers mean a crash mid-ingest — safe to delete when no
  publish is running.
- `tile-archives/<id>/` holds the tars iOS bundle downloads are served from,
  built lazily on the first device request and kept as a cache. Each ingest
  deletes the whole directory for the published site **and** every course on
  it, so the tars are rebuilt from the newly published tiles on the next
  download — nothing accumulates across publishes for a site you keep
  publishing. Deleting the directory by hand is always safe.
- A stale `<site>.trash-*` tile tree from an interrupted swap is likewise
  deletable; the next ingest for that site sweeps it as well.

## 11. Upgrades

```sh
cd /srv/golf-map && sudo -u golfmap git pull
cd server && sudo -u golfmap bun install
cd ../web && sudo -u golfmap bun install && sudo -u golfmap bun run build
sudo systemctl restart golf-map
curl -s localhost:3000/api/meta
```

App-DB migrations run automatically at boot. Rebuild `web/dist` on every deploy:
the HTML entries are `no-cache` and name hashed bundles, so a stale `dist` is a
stale app for everyone who reloads.

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every page 503s with "Web app not built" | `WEB_DIST_DIR` wrong, or `bun run build` never ran in `web/` |
| `/api/...` returns the app shell | something other than this build is serving statics ahead of the API — check handler order (§4) |
| A builder API 404s | expected: it is not mounted in serve mode. The web UI hides it; a client that still calls it is out of date |
| Map tiles blocked in the browser console | `CROSS_ORIGIN_RESOURCE_POLICY` — set `cross-origin` when the app is served from another origin |
| "Unexpected token '<'" in the console | a missing hashed asset (stale HTML against a newer `dist`) — rebuild and hard-reload |
| `mode: "builder"` on the VPS | `SERVER_MODE` not set in the unit's `EnvironmentFile`; every builder route is exposed — fix immediately |
