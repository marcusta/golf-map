# Deploying golf-map to the Sweden Indoor Golf VPS (sig-infra)

How this repo plugs into [sig-infra](https://github.com/) — the template-based
service manager behind `app.swedenindoorgolf.se`. The service runs in
`SERVER_MODE=serve` at **https://app.swedenindoorgolf.se/golf-map/**.

This is the *sig-infra-specific* half. Everything about operating a serve-mode
box — the data layout, publish/ingest, backups, observability, troubleshooting —
lives in [vps-serve-runbook.md](./vps-serve-runbook.md) and is **not** repeated
here; the design rationale is in
[feature-local-builder-vps-serve.md](../feature-local-builder-vps-serve.md).
Where the two disagree, this document wins for the SIG box: the runbook
describes a standalone VPS at the origin root, this one a path-routed service
sharing a host with tapscore and friends.

---

## 1. The one thing that makes this deploy different: the path prefix

sig-infra runs many services on one host and routes them by **path**:

```
https://app.swedenindoorgolf.se/golf-map/...  →  Caddy  →  localhost:3801
```

The Caddy block uses `handle_path` (`stripPath: true`, the sig-infra default),
which **strips `/golf-map` before proxying**. So:

| | sees |
|---|---|
| **Browser / iOS app** | `/golf-map/api/meta`, `/golf-map/tiles/…`, `/golf-map/assets/main-<hash>.js` |
| **bun server** | `/api/meta`, `/tiles/…`, `/assets/main-<hash>.js` |

That split is the whole design:

- **Server code needs no prefix awareness and deliberately has none.** Routes,
  `server/services/static.ts` and its SPA fallbacks all keep matching rooted
  paths. (If anyone ever flips this service to `stripPath: false`, `static.ts`
  is the file that breaks — there is a comment saying so.)
- **Client code must add the prefix**, because the browser resolves URLs against
  the document, which *does* carry it.

The client's single source for it is vite's `base`
([`web/vite.config.ts`](../../web/vite.config.ts)), which becomes
`import.meta.env.BASE_URL` → `BASE_PATH` in `@basics/core/client/base`. From
there:

| what | how it gets the prefix |
|---|---|
| hashed asset URLs, `<link rel=manifest>`, apple-touch-icon | vite rewrites the html entries at build |
| app API calls | `API_BASE` (`BASE_PATH + '/api'`), re-exported from `web/src/api.ts` |
| framework API calls (auth, obs) | `API_BASE` in `@basics/core/client/base` |
| MapLibre tile templates | `BASE_PATH` in `tileUrlTemplate` (`web/src/map/map-style.ts`) |
| pushState routes, desktop **and** `/m/*` | the framework `Router` strips the base on read and adds it on `navigate` — route strings stay app-relative, so nothing in app code changes |
| PWA manifest `scope`/`start_url`/icons | the `baseAwareManifest` vite plugin rewrites the emitted copy |

`base` is keyed on vite's `command === 'build'`, **not** `NODE_ENV`: vite only
defaults `NODE_ENV` to production when it is unset, so an inherited value would
silently produce a root-based bundle that 404s only on the VPS.
`WEB_BASE=/ bun run build` overrides it for a box serving at the origin root
(the standalone setup in the runbook).

Regression cover: `web/tests/build-base-path.test.ts` runs the real build and
asserts the prefix in both html entries and the manifest;
`ios/GolfMapTests/API/DeployPrefixTests.swift` pins that a path-bearing base URL
survives the iOS API/tile joiners.

---

## 2. Prerequisite: the framework checkout

`@basics/core` is consumed as a `file:` dependency at
`../../mackans-client-fw/core` (relative to `server/`, `web/`, `shared/`) and
`../mackans-client-fw/core` from the repo root. That resolves on the server
**iff the framework is cloned as a sibling of the service folder**:

```sh
sudo -u golfmap git clone <framework-repo-url> /srv/mackans-client-fw
```

`/srv/golf-map` + `/srv/mackans-client-fw` reproduces the local layout exactly,
so no path rewriting is needed. This is the chosen v1 approach — the framework is
**not** vendored into this repo (unlike tapscore, which snapshots it under
`vendor/basics-core`).

> **Framework updates need two steps.** `git pull` in `/srv/mackans-client-fw`
> is not enough: bun **copies** a `file:` dependency into
> `node_modules/.bun/@basics+core@…` at install time, and the store key is
> derived from the path, not the contents — so a plain `bun install` sees
> nothing to do and the old copy keeps being served. Always:
>
> ```sh
> cd /srv/mackans-client-fw && sudo -u golfmap git pull
> cd /srv/golf-map          && sudo -u golfmap bun install --force
> sudo systemctl restart golf-map
> ```

---

## 3. sig-infra configuration

### 3.1 `services.json` (in the sig-infra repo — GitOps: edit, commit, push, pull on the server)

```json
"golf-map": {
    "port": 3801,
    "healthCheckPath": "/api/meta"
}
```

`stripPath` is omitted — the default `true` is what we want (§1). Port 3801 was
free at the time of writing; the taken set was 3000, 3001, 3002, 3004, 3005,
3010, 3100, 3101, 3201, 3402, 3737, 4005, 4810.

By sig-infra convention the local folder name drives everything, and ours is
already `golf-map`: service name = systemd unit = Caddy path = `/srv/golf-map`.
That is why [`deploy.json`](../../deploy.json) sets neither `serviceName` nor
`serverFolder`.

### 3.2 `deploy.json` (this repo, already committed)

```json
{
    "database": {
        "path": "data/app.sqlite",
        "migrate": "bun run db:migrate",
        "validate": "bun run db:health",
        "migrationsDir": "server/db/migrations"
    },
    "install": "bun install && bun run --cwd web build",
    "healthCheck": "curl -f http://localhost:3801/api/meta"
}
```

- `install` also **builds the web app on the server** — `web/dist` is gitignored
  and stays that way, so there is no built artifact in the repo to go stale.
- `db:migrate` / `db:health` are root scripts
  ([`scripts/migrate.ts`](../../scripts/migrate.ts),
  [`scripts/health.ts`](../../scripts/health.ts)). They run **on the server, as
  the service user, with cwd `/srv/golf-map`**, against a `VACUUM INTO` snapshot
  taken with the service stopped, with `DB_PATH` pointing at that snapshot. The
  live DB is only replaced by a file that already migrated *and* validated.
- `migrate.ts` reuses the same Kysely migrator the server runs at boot, so the
  deploy step applies exactly what startup would; it is idempotent.
- `health.ts` asserts every table in `server/db/schema.ts`'s `Database`
  interface exists. `scripts/health.test.ts` fails the build if the two lists
  drift — a table missing from the list is simply never validated.

### 3.3 `service_create`

Run from this repo's directory on the local Mac. The wizard prompts for:

| prompt | answer |
|---|---|
| Service name | `golf-map` (the folder default) |
| GitHub repository | the golf-map repo |
| Description | `golf-map — course mapping + on-course companion (serve mode)` |
| **Start command** | `/usr/local/bin/bun run start` |
| Port | `3801` |

`start` is the root script `bun server/main.ts`. Running from the repo root
(`WorkingDirectory=/srv/golf-map`) is deliberate: `main.ts` resolves its
migrations folder and the default `WEB_DIST_DIR` from `import.meta.dir`
(absolute, so unaffected), while the cwd-relative defaults — `DATA_DIR=./data`,
`DB_PATH=./data/app.sqlite` — land on `/srv/golf-map/data`, which is exactly the
`data/app.sqlite` that `deploy.json` declares. Do **not** set
`WorkingDirectory=/srv/golf-map/server`; the DB paths would diverge from the ones
sig-infra migrates.

---

## 4. systemd unit environment

`service_create` writes the unit with `ExecStart=<start command>`,
`WorkingDirectory=/srv/golf-map` and `Environment=NODE_ENV=production`. Add the
rest at creation time (or with `systemctl edit`); the full set this service
needs:

```ini
Environment=NODE_ENV=production
Environment=SERVER_MODE=serve
Environment=PORT=3801

# Data layout. DATA_DIR holds tiles/, dem/, tile-archives/, incoming/.
# These match the cwd-relative defaults, but are set explicitly so a change of
# WorkingDirectory can never silently move the database.
Environment=DATA_DIR=/srv/golf-map/data
Environment=DB_PATH=/srv/golf-map/data/app.sqlite
Environment=SESSION_DB_PATH=/srv/golf-map/data/sessions.sqlite
Environment=OBS_DB_PATH=/srv/golf-map/data/obs.sqlite
Environment=WEB_DIST_DIR=/srv/golf-map/web/dist

# Ingest uploads a 60–80 MB bundle in ONE request. The framework defaults
# (1 MB body, 30 s timeout — see @basics/core/server/config.ts) are far below
# that and MUST be raised, or publish fails with a 413/timeout that looks like
# a network fault.
Environment=BODY_LIMIT=268435456
Environment=REQUEST_TIMEOUT=900000

# Bearer secret for POST /api/ingest/site. Blank/missing = every publish is
# rejected (fail closed). Generate with `openssl rand -base64 48`.
# Prefer EnvironmentFile=/etc/golf-map.env (0640 root:golfmap) so the token is
# not readable in `systemctl show`.
Environment=PUBLISH_TOKEN=<48 random bytes, base64>

# tapscore runs on the same box; the bridge talks to it directly, not through
# Caddy.
Environment=TAPSCORE_BASE_URL=http://localhost:3737
```

`DB_PATH`, `SESSION_DB_PATH`, `OBS_DB_PATH`, `BODY_LIMIT`, `REQUEST_TIMEOUT`,
`PORT` are read by the framework (`@basics/core/server/config.ts`);
`SERVER_MODE`, `DATA_DIR`, `WEB_DIST_DIR`, `PUBLISH_TOKEN` and
`TAPSCORE_BASE_URL` by this repo.

Not needed here, unlike the standalone runbook: `CROSS_ORIGIN_RESOURCE_POLICY` /
`CORS_ORIGIN` stay at their defaults, because Caddy serves the app and the API
from the **same origin** — tiles are same-origin WebGL textures, so the default
`same-origin` policy is correct.

Optional, same meaning as the runbook (§8): `LOG_LEVEL=info`, `TRACE_TTL_DAYS=3`,
`OBS_MAX_MB=64`.

The service serves the built web app itself (`server/services/static.ts`, mounted
in serve mode) — the sig-infra Caddy block is a plain `reverse_proxy`, so there
is no separate `root`/`file_server` stanza to configure. Both SPA entries and the
asset cache policy are handled in-process.

---

## 5. Publishing to it

Publish runs on the **builder** (the local Mac) and targets the public URL —
Caddy strips the prefix, so `POST /golf-map/api/ingest/site` arrives at the
server as `/api/ingest/site`:

```sh
export PUBLISH_URL=https://app.swedenindoorgolf.se/golf-map
export PUBLISH_TOKEN=<same value as the unit's>
cd server && bun run publish <siteId>
```

`server/scripts/publish.ts` reads both from the environment (`PUBLISH_URL` is
the base URL, `PUBLISH_TOKEN` the bearer). Token provisioning and rotation:
runbook §6. What a bundle contains and how ingest swaps it atomically: runbook §7.

> Do not point `PUBLISH_URL` at `http://localhost:3801` from the box itself
> unless you mean to bypass Caddy's raised `request_body` limit — the sig-infra
> Caddy block must allow the 60–80 MB upload for the public URL to work. Verify
> once with a small site before relying on it.

---

## 6. First-deploy checklist

1. **Framework clone** on the box: `/srv/mackans-client-fw` (§2).
2. **sig-infra**: add the `services.json` entry (§3.1), commit, push, pull on the
   server.
3. **`service_create`** with the answers in §3.3.
4. **Unit environment**: add every `Environment=` line from §4 (put
   `PUBLISH_TOKEN` in `/etc/golf-map.env`), then `daemon-reload` + restart.
5. **Deploy**: `deploy --db` from this repo. Watch that `install` completes the
   web build — it is the longest step and the only one that needs `web/`'s deps.
6. **Verify**:
   ```sh
   curl -s https://app.swedenindoorgolf.se/golf-map/api/meta   # → {"…","mode":"serve"}
   caddy_status golf-map
   ```
   Then load the page and confirm the bundle URLs carry the prefix
   (`/golf-map/assets/…`) and return 200.
7. **Create a user** on the box — publish never carries user rows (runbook §5):
   ```sh
   cd /srv/golf-map/server
   sudo -u golfmap env DB_PATH=/srv/golf-map/data/app.sqlite bun db/create-user.ts <username>
   ```
8. **Publish a site** from the builder (§5), then check it renders and tiles load.
9. **iOS**: set the app's server base URL to
   `https://app.swedenindoorgolf.se/golf-map` (no trailing `/api` — the client
   appends it). The path is preserved by every joiner; see `DeployPrefixTests`.
10. **Mobile PWA**: open `https://app.swedenindoorgolf.se/golf-map/m`, add to
    home screen, and confirm the standalone launch stays in-app (scope is
    `/golf-map/m`).
