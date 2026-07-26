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

> **The two documents use different service users, on purpose.** sig-infra's
> `service_create` runs `adduser --system --group "$SERVICE_NAME"`, and
> `deploy.ts` runs every install/migrate step as `sudo -u <folder>` — so on the
> SIG box the user is **`golf-map`**, spelled exactly like the folder. The
> standalone runbook creates its own user by hand and calls it `golfmap`
> (no hyphen). Both are correct in their own document; do not "fix" either one
> to match the other.

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
| framework API calls (auth, obs dashboard) | `API_BASE` in `@basics/core/client/base` |
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

> **The obs dashboard row needs a recent enough framework.** Older
> `@basics/core` builds hardcode `'/api/_obs'` in
> `client/obs/obs.api.instance.ts`, which resolves against the origin root and
> misses this service entirely — the dashboard loads but every panel is empty.
> It now goes through `API_BASE`, fixed in `@basics/core` **1.1.0** (§2). A box
> still on an older vendored tarball needs a `fw:update` commit and a web
> rebuild before the dashboard works under `/golf-map/`.

---

## 2. The framework dependency (no extra checkout needed)

`@basics/core` is consumed as a **versioned tarball committed to this repo** at
`vendor/basics-core-<X.Y.Z>.tgz`, declared by all four package.json files
(root, `server/`, `web/`, `shared/`). `git pull && bun install` on the box
resolves it with no network access to the framework repo and **no framework
clone on the server** — `/srv/mackans-client-fw` is no longer a prerequisite.

The version is visible in the dependency string, so it is always obvious which
framework a given deployed commit shipped against, and a rollback of this repo
rolls the framework back with it, atomically.

> **Framework updates happen on the DEV machine, never on the box.** From a
> local checkout with `mackans-client-fw` as a sibling:
>
> ```sh
> cd ~/dev/github/golf-map
> bun run fw:update            # bare = latest tag; or fw:update 1.2.0
> # run the checks, then commit vendor/*.tgz + the four package.jsons + bun.lock
> ```
>
> The box then just takes the normal deploy path (`git pull`, `bun install`,
> rebuild, restart). No `--force`, no second repo to keep in sync.

---

## 3. sig-infra configuration

### 3.1 `services.json` (in the sig-infra repo)

The end state is:

```json
"golf-map": {
    "port": 3801,
    "healthCheckPath": "/api/meta"
}
```

**Do not hand-write this before `service_create`.** The wizard calls
`caddy_add` internally, and `caddy_add` aborts with
`Service 'golf-map' already exists` if the key is already in `services.json`.
The order that works — and the one §6 follows — is:

1. `service_create` (§3.3) → `caddy_add` writes `"golf-map": { "port": 3801 }`,
   commits, pushes, and regenerates the Caddyfile on the server.
2. *Then* add `"healthCheckPath": "/api/meta"` by hand in the sig-infra repo and
   commit/push/pull — `caddy_add` only ever writes `{port}`.

`healthCheckPath` is what `status.ts` (`caddy_status`) probes; it does not
affect routing, so adding it second costs nothing. `stripPath` is omitted — the
default `true` is what we want (§1). Port 3801 was free at the time of writing;
the taken set was 3000, 3001, 3002, 3004, 3005, 3010, 3100, 3101, 3201, 3402,
3737, 4005, 4810.

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

**The server also migrates at boot, which can bypass the safety net.**
`createApp` runs the migrator against the **live** database on startup. So a
`deploy --no-db` that ships a pending migration still applies it — just without
the snapshot, the validation step and the auto-rollback that `--db` provides.
Because `deploy.json` sets `migrationsDir`, let sig-infra decide instead of
guessing: `deploy --auto` diffs `server/db/migrations` against the commit
currently on the server and picks `--db` or `--no-db` for you, and
`deploy_check` prints the same verdict without deploying. Only reach for an
explicit `--no-db` when `deploy_check` has already said there are no migration
changes.

**Watch the install timeout on a cold deploy.** `deploy.ts` hard-codes
`INSTALL_TIMEOUT_SECS = 300` (not configurable), and our `install` is both
`bun install` *and* a full vite build of two entries. On the 2-vCPU box a cold
run with an empty bun cache can approach that. If the deploy fails with
`Install command timed out after 300s`, prime it once by hand and redeploy —
the second run only has to rebuild:

```sh
ssh <sig-server> 'cd /srv/golf-map && sudo -u golf-map bun install'
deploy --auto
```

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
`WorkingDirectory=/srv/golf-map` and `Environment=NODE_ENV=production` — and
nothing else. Add the rest with `systemctl edit` (or by editing the unit
directly) **before the first deploy**; the full set this service needs:

> **`PORT=3801` must be in the unit before you deploy.** Nothing derives the
> port from `services.json` at runtime — `@basics/core` reads `PORT` and
> **defaults to 3000**. Without it the unit starts happily on the wrong port,
> `deploy.json`'s `curl -f http://localhost:3801/api/meta` fails, and
> `deploy.ts` treats that as a bad release and auto-recovers: it resets the
> code and restarts. The symptom is a rollback loop with a perfectly healthy
> app answering on 3000. The same goes for `SERVER_MODE=serve` — the default
> mode does not mount the static routes or the ingest endpoint.

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
# Prefer EnvironmentFile=/etc/golf-map.env (0640 root:golf-map) so the token is
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

Optional, same meaning as the runbook (§8): `LOG_LEVEL=info`,
`TRACE_TTL_DAYS=3`. **Not** `OBS_MAX_MB` — the only reader is
`server/scripts/obs-rotate.ts`, which runs from a timer/cron, not from the
server process. Set it on that unit or inline in the cron entry; in the service
unit it does nothing.

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

> **The 60–80 MB upload through Caddy is untested.** sig-infra's `generate.ts`
> emits no `request_body` directive at all, so Caddy applies no size cap of its
> own and the real limit is the server-side `BODY_LIMIT` above — unlike the
> standalone runbook, whose hand-written Caddyfile *does* set `request_body`.
> That should mean large publishes pass straight through, but nobody has run
> one yet. **Publish a small site first** and only then a full one. If a big
> bundle fails at the edge rather than at the app, the fix is a
> `request_body { max_size 256MB }` in the sig-infra template — a change to
> that repo, not this one.

---

## 6. First-deploy checklist

Order matters here, and not in the obvious way. A fresh box has **no database**,
and `deploy --db` starts by snapshotting one — `db-tool.ts snapshot` fails with
`Source not found` if `/srv/golf-map/data/app.sqlite` does not exist. So the
very first deploy must be `--no-db`: the server creates the database and runs
every migration itself on first boot, and only *later* deploys have something to
snapshot. Nothing in sig-infra creates the `data/` directory either.

1. **`service_create`** with the answers in §3.3. This creates the `golf-map`
   system user, clones the repo to `/srv/golf-map`, writes and *enables* the
   unit (it does not start it), and calls `caddy_add` to register port 3801.
2. **`healthCheckPath`**: add `"healthCheckPath": "/api/meta"` to the now-existing
   `services.json` entry in the sig-infra repo; commit, push, pull on the
   server, `bun generate.ts` (§3.1).
3. **No framework clone is needed** — `@basics/core` rides along as a committed
   tarball in `vendor/` (§2). An older `/srv/mackans-client-fw` left over from a
   previous deploy is inert and can be removed.
4. **Unit environment**: add every `Environment=` line from §4 — `PORT=3801` and
   `SERVER_MODE=serve` are not optional (see the warning there) — put
   `PUBLISH_TOKEN` in `/etc/golf-map.env`, then `systemctl daemon-reload`. Do
   **not** start the service yet; nothing is installed or built.
5. **Data directory**, owned by the service user so the app can create its
   SQLite files:
   ```sh
   sudo mkdir -p /srv/golf-map/data
   sudo chown golf-map:golf-map /srv/golf-map/data
   ```
6. **Pre-flight**: `deploy_preflight` from this repo — it validates `deploy.json`,
   that the migrate/validate scripts exist and that the remote state looks sane,
   before anything is touched.
7. **First deploy**: `deploy --no-db` (see the note above — there is no database
   to snapshot yet). `install` runs `bun install` and the web build; watch for
   the 300 s timeout (§3.2). The service then boots, creates
   `data/app.sqlite`, and applies every migration.
8. **Verify**:
   ```sh
   curl -s https://app.swedenindoorgolf.se/golf-map/api/meta   # → {"…","mode":"serve"}
   caddy_status golf-map
   ```
   Then load the page and confirm the bundle URLs carry the prefix
   (`/golf-map/assets/…`) and return 200.
9. **Create a user** on the box — publish never carries user rows (runbook §5):
   ```sh
   cd /srv/golf-map/server
   sudo -u golf-map env DB_PATH=/srv/golf-map/data/app.sqlite bun db/create-user.ts <username>
   ```
10. **Publish a site** from the builder (§5) — a small one first (§5's note) —
    then check it renders and tiles load.
11. **iOS**: set the app's server base URL to
    `https://app.swedenindoorgolf.se/golf-map` (no trailing `/api` — the client
    appends it). The path is preserved by every joiner; see `DeployPrefixTests`.
12. **Mobile PWA**: open `https://app.swedenindoorgolf.se/golf-map/m`, add to
    home screen, and confirm the standalone launch stays in-app (scope is
    `/golf-map/m`).

From here on the database exists, so **every subsequent deploy is
`deploy --auto`** (or `deploy --db` when you know a migration is pending) — that
is what buys the snapshot, the validation and the auto-rollback. `--no-db` is a
first-deploy-only special case.
