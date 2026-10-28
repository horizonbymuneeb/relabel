# relabel demo — Nova Status (live)

Real end-to-end white-label proof on this box: Uptime Kuma 1.23.17 source clone,
patched by `relabel` (`scan` → `init` → `apply`), rebuilt into a Docker image and
served live at **https://status.muneebs.space** (Cloudflare proxied → nginx →
127.0.0.1:3001).

- Brand: **Nova Status**, domain `status.muneebs.space`, palette `#2563EB` / `#60A5FA`
- Logo/favicon: from the app's own `public/` assets (`icon.svg`, `favicon.ico`)
- App source clone: `/srv/relabel-demo/uptime-kuma-src` (tag `1.23.17`, matching the
  `louislam/uptime-kuma:1` image)
- Running container: `uptime-kuma-demo` (image `uptime-kuma-demo:nova`), data volume
  `/srv/relabel-demo/uptime-kuma` → `/app/data`
- Reports: `verify.json`, `report.html`, `brand.yaml` (this dir)
- Screenshots: `../shots/`

## Stage 1 — interim proof (workaround for apply bug)

Artifacts currently in this directory come from **run 1 (interim)**:

- `verify.json` — `node dist/cli.js verify --url https://status.muneebs.space --brand /srv/relabel-demo/uptime-kuma-src/brand.yaml --shots demo/shots --out demo/reports/verify.json`
- `report.html` — `node dist/cli.js report --input demo/reports/verify.json --out demo/reports/report.html`
- shots `after-*` are copies of verify's `desktop.png` / `mobile.png`

Result: **6 passed, 1 failed, 0 skipped**

| check | status | detail |
|---|---|---|
| brand-strings | PASS | 0 occurrences across 3 old-brand variants (rendered text + HTML) |
| brand-title | PASS | desktop: "Nova Status - Login"; mobile: "Nova Status - Login" |
| console-errors | PASS | 0 page errors, 0 console errors |
| overflow-desktop | PASS | scrollWidth 1440 − innerWidth 1440 = 0 |
| overflow-mobile | PASS | scrollWidth 390 − innerWidth 390 = 0 |
| screenshots | PASS | desktop + mobile saved |
| favicon | FAIL | `favicon fetch failed: apiRequestContext.get: Protocol "data:" not supported` |

The favicon failure is a **verify-tool limitation, not a branding failure**: after the
SPA loads, Kuma's favicon-badge script rewrites `<link rel="icon">` to a
`data:image/png;base64,…` URI rendered from `/icon.svg`; verify's HTTP fetch cannot
read `data:` URIs. Served HTML correctly points at `/icon.svg`.

Workarounds needed for run 1 (both in the `/srv` clone only; no repo files edited):

1. `apply` rewrote module refs `./uptime-kuma-server` → `./nova-status-server` but did
   not rename the file, so the container crashed with `Cannot find module
   './nova-status-server'`. Interim fix: `cp server/uptime-kuma-server.js
   server/nova-status-server.js`.
2. `apply` rewrote Dockerfile `FROM` refs to `louislam/nova-status:builder-go` /
   `:base-debian` (nonexistent repos). Interim fix: local
   `docker tag louislam/uptime-kuma:base-debian louislam/nova-status:base-debian` (same
   for `builder-go`), then `docker build --target release` succeeded.

Note: the upstream Dockerfile does not build the frontend; like upstream CI
(`build-docker-debian`), the host must run `npm ci --include=dev` + `npm run build`
(vite, ~3–6 min on this 2-vCPU box) before `docker build`, and `.dockerignore` does not
exclude `dist`.

## Stage 2 — clean re-run

_To be filled after the fixed `apply`/recipe land (file renames + never rewrite
FROM/image refs). Final reported artifacts will be replaced by that run._

## Environment / provisioning (Phase A)

```bash
# container
docker run -d --name uptime-kuma-demo --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v /srv/relabel-demo/uptime-kuma:/app/data \
  louislam/uptime-kuma:1            # 1.23.17, arm64 OK
# source
git clone --depth 1 https://github.com/louislam/uptime-kuma.git /srv/relabel-demo/uptime-kuma-src
git -C /srv/relabel-demo/uptime-kuma-src checkout 1.23.17
# DNS (Cloudflare, proxied A record; record id 3ac09904b057d973f2a4b58a743aee78)
curl -X POST -H "Authorization: Bearer $CF_DNS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"type":"A","name":"status.muneebs.space","content":"129.146.163.180","ttl":1,"proxied":true}' \
  "https://api.cloudflare.com/client/v4/zones/cac6267e0c6f3d8d8057cbb12141deee/dns_records"
# nginx: /etc/nginx/sites-available/status.muneebs.space (websocket Upgrade/Connection)
#   backup first: /etc/nginx/backup-20261029-035132 (sites-available, sites-enabled, nginx.conf)
#   nginx -t && systemctl reload nginx
# TLS
certbot --nginx -d status.muneebs.space --non-interactive --agree-tos -m muneeb@muneebs.space --redirect
#    (python3-certbot-nginx was missing and had to be apt-installed)
```

Verification of Phase A: `curl -sL https://status.muneebs.space/` → 200, container
healthy, nginx -t OK.

## Commands (run from /home/ubuntu/work/relabel)

```bash
node dist/cli.js scan /srv/relabel-demo/uptime-kuma-src --json --save      # -> .relabel/scan.json
node dist/cli.js init /srv/relabel-demo/uptime-kuma-src \
  --name "Nova Status" --domain status.muneebs.space \
  --primary "#2563EB" --accent "#60A5FA" \
  --logo /srv/relabel-demo/uptime-kuma-src/public/icon.svg \
  --favicon /srv/relabel-demo/uptime-kuma-src/public/favicon.ico
node dist/cli.js apply /srv/relabel-demo/uptime-kuma-src --brand /srv/relabel-demo/uptime-kuma-src/brand.yaml --dry-run
node dist/cli.js apply /srv/relabel-demo/uptime-kuma-src --brand /srv/relabel-demo/uptime-kuma-src/brand.yaml
# rebuild (upstream flow: frontend build on host, then docker build)
cd /srv/relabel-demo/uptime-kuma-src && npm ci --include=dev && npm run build
docker build -f docker/dockerfile --target release -t uptime-kuma-demo:nova .
docker rm -f uptime-kuma-demo
docker run -d --name uptime-kuma-demo --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v /srv/relabel-demo/uptime-kuma:/app/data uptime-kuma-demo:nova
# verify + report (from /home/ubuntu/work/relabel)
node dist/cli.js verify --url https://status.muneebs.space \
  --brand /srv/relabel-demo/uptime-kuma-src/brand.yaml --shots demo/shots \
  --out demo/reports/verify.json
node dist/cli.js report --input demo/reports/verify.json --out demo/reports/report.html
```

## Observed gaps / notes

- `apply` (run 1) does not rename files when it rewrites module refs → broken runtime
  require (fixed by core-cli; clean run required).
- `apply` rewrote Dockerfile base-image refs to an unpublished namespace
  (`louislam/nova-status:*`) → build breaks unless local aliases or skip-FROM rule.
- Palette: `#2563EB` lands in status-page accent config (`src/util-frontend.js`), the
  Kuma app chrome keeps its upstream green primary (`$primary: #5cdd8b`); no palette
  assertion in verify.
- Official `louislam/uptime-kuma:1` image injects `/app/dist/docker-latest-warning.js`
  which overlays an "outdated version" screen; it is absent from the source build (and
  gone live now).
- Cloudflare terminates TLS at the edge for proxied records (origin also has a valid
  Let's Encrypt cert for `status.muneebs.space`, verified locally over 127.0.0.1).
