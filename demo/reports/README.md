# relabel demo — Nova Status (live)

Real end-to-end white-label proof on this box: Uptime Kuma **1.23.17** source clone,
patched by `relabel` **1.0.0** (`scan` → `init` → `apply`), rebuilt into a Docker image
and served live at **https://status.muneebs.space** (Cloudflare proxied → nginx →
127.0.0.1:3001).

- Brand: **Nova Status**, domain `status.muneebs.space`, palette `#2563EB` / `#60A5FA`
- Logo/favicon: from the app's own `public/` assets (`icon.svg`, `favicon.ico`)
- App source clone: `/srv/relabel-demo/uptime-kuma-src` (tag `1.23.17`, HEAD `40ec715`,
  matching the `louislam/uptime-kuma:1` image)
- Running container: `uptime-kuma-demo` (image `uptime-kuma-demo:nova`,
  `sha256:e44565f1ebdf`), data volume `/srv/relabel-demo/uptime-kuma` → `/app/data`
- Reports (this dir): `verify.json`, `report.html`, `brand.yaml` (+ `public/` asset copies
  so the brand spec is self-contained)
- Screenshots: `../shots/`

## Stage 2 — clean run (current artifacts, relabel 1.0.0)

Artifacts in this directory are from **run 2 (clean)**, 2026-10-29 05:02–05:03 PKT,
against the fixed `apply`/`verify` (renames files, never rewrites Docker `FROM`/image
refs, favicon check handles `data:` URIs).

```bash
# from /home/ubuntu/work/relabel
cp /srv/relabel-demo/brand.yaml /srv/relabel-demo/uptime-kuma-src/brand.yaml
node dist/cli.js apply /srv/relabel-demo/uptime-kuma-src \
  --brand /srv/relabel-demo/uptime-kuma-src/brand.yaml
# assertions after apply:
#   FROM lines still louislam/uptime-kuma:builder-go|base-debian  (all 6)
#   server/uptime-kuma-server.js -> server/nova-status-server.js (renamed, 13 refs resolve)
#   relative requires: 305 checked, 0 broken; LICENSE diff: 0 lines
#   git diff --stat: 152 files changed, 506 insertions(+), 987 deletions(-)
cd /srv/relabel-demo/uptime-kuma-src && npm run build          # vite, 4m34s
docker build -f docker/dockerfile --target release -t uptime-kuma-demo:nova .   # EXIT 0, no alias hack
docker rm -f uptime-kuma-demo
docker run -d --name uptime-kuma-demo --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v /srv/relabel-demo/uptime-kuma:/app/data uptime-kuma-demo:nova
# verify + report
node dist/cli.js verify --url https://status.muneebs.space \
  --brand demo/reports/brand.yaml --shots demo/shots --out demo/reports/verify.json --json
node dist/cli.js report --input demo/reports/verify.json --out demo/reports/report.html
```

Result — `verify` exit **0**, **7 passed, 0 failed, 0 skipped**
(`demo/reports/verify.json`, generated `2026-10-29T00:02:53Z`):

| check | status | detail |
|---|---|---|
| brand-strings | PASS | 0 occurrences across 3 old-brand variants (rendered text + HTML) |
| brand-title | PASS | desktop: "Nova Status - Login"; mobile: "Nova Status - Login" |
| console-errors | PASS | 0 page errors, 0 console errors |
| overflow-desktop | PASS | scrollWidth 1440 − innerWidth 1440 = 0 |
| overflow-mobile | PASS | scrollWidth 390 − innerWidth 390 = 0 |
| screenshots | PASS | desktop (20371 B) + mobile (15879 B) saved |
| favicon | PASS | HTTP 200, sha256 `1f7b4df28ef0…` matches brand logo `public/icon.svg` (status.muneebs.space/icon.svg) |

Live page after run 2: `curl -sL https://status.muneebs.space/` → 200 (final `/dashboard`),
`<title>Nova Status</title>`, 0 "Uptime Kuma" occurrences in HTML. Container healthy;
`/app/dist/docker-latest-warning.js` absent (source build drops the legacy-image overlay).
`report.html` — `relabeld report 1.0.0`, 57 KB, embeds both screenshots, "7 passed".

`after-desktop-1440x980.png` / `after-mobile-390x844.png` are copies of the verify run's
`desktop.png` / `mobile.png` (1440×980 and 390×844).

## Stage 1 — interim run (historical, superseded)

Run 1 (04:23 PKT) used the pre-fix CLI and needed two workarounds; artifacts kept in
`stage1/` (`verify.json`, `report.html`, `brand.yaml`). Result: 6 passed, 1 failed —
`favicon` failed because `apply` had not yet been fixed and verify tried to HTTP-fetch a
canvas-generated `data:` URI. Workarounds that run needed (all in `/srv` clone only):

1. `apply` rewrote `require("./uptime-kuma-server")` refs but did not rename the file →
   container crash `Cannot find module './nova-status-server'`; interim fix
   `cp server/uptime-kuma-server.js server/nova-status-server.js`.
2. `apply` rewrote Dockerfile `FROM` refs to `louislam/nova-status:builder-go|base-debian`
   (nonexistent repos); interim fix: local `docker tag` aliases.

Both are fixed in relabel 1.0.0 — no workarounds are used by the stage-2 artifacts.

## Phase A — provisioning (2026-10-29 ~03:49–03:52 PKT)

```bash
# container (arm64 OK; louislam/uptime-kuma:1 = 1.23.17)
docker run -d --name uptime-kuma-demo --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v /srv/relabel-demo/uptime-kuma:/app/data louislam/uptime-kuma:1
# source
git clone --depth 1 https://github.com/louislam/uptime-kuma.git /srv/relabel-demo/uptime-kuma-src
git -C /srv/relabel-demo/uptime-kuma-src fetch --depth 1 origin tag 1.23.17
git -C /srv/relabel-demo/uptime-kuma-src checkout 1.23.17
# DNS: proxied A record, Cloudflare zone <redacted-cf-zone-id> (record <redacted-cf-record-id>)
curl -X POST -H "Authorization: Bearer $CF_DNS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"type":"A","name":"status.muneebs.space","content":"<server-ip>","ttl":1,"proxied":true}' \
  "https://api.cloudflare.com/client/v4/zones/<redacted-cf-zone-id>/dns_records"
# nginx: /etc/nginx/sites-available/status.muneebs.space (proxy_pass 127.0.0.1:3001,
#        websocket Upgrade/Connection headers); config backup /etc/nginx/backup-20261029-035132
nginx -t && systemctl reload nginx
# TLS (python3-certbot-nginx had to be apt-installed; plugin was missing)
certbot --nginx -d status.muneebs.space --non-interactive --agree-tos -m muneeb@muneebs.space --redirect
```

Only additive changes were made (new subdomain/port/container/cert); dsh, reme, supabase
and brightbean were untouched. certbot expires 2027-01-26.

## Notes / observed gaps

- Upstream's Dockerfile does not build the frontend: like upstream CI, the host must run
  `npm ci --include=dev` + `npm run build` (vite, 3–6 min on this 2-vCPU box) before
  `docker build --target release`; `.dockerignore` does not exclude `dist`.
  (`npm config get omit` is `dev` on this box, so `--include=dev` is required.)
- Palette: `#2563EB` lands in the status-page accent (`src/util-frontend.js`); the Kuma app
  chrome keeps its upstream green primary (`$primary: #5cdd8b`). No palette assertion exists
  in verify.
- Official `louislam/uptime-kuma:1` image injects `/app/dist/docker-latest-warning.js`
  (an "outdated version" overlay); absent from the source build and gone live.
- Cloudflare terminates TLS at the edge for proxied records; origin also has a valid
  Let's Encrypt cert for `status.muneebs.space` (verified over 127.0.0.1 with `-k`).
- Admin setup for the demo was completed once against the container's persisted volume
  (`admin` / demo password) so the live URL lands on the branded login page.
