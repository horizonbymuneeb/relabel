# Demo gallery

A worked example of the full loop on a real app: **Uptime Kuma 1.23.17**, rebuilt from source and
white-labelled as **Nova Status**, then verified by `relabeld` v0.1.0 in headless Chromium. The
static page is [demo/site/index.html](../demo/site/index.html); it is self-contained and links only
files in this repository.

| | |
|---|---|
| Source app | Uptime Kuma 1.23.17 (self-hosted status page) |
| Demo brand | Nova Status (fictional) |
| Hosted at | `status.muneebs.space` |
| Gate | `relabeld verify`: seven checks, exit code as the verdict |
| Captured with | headless Chromium via `verify`, desktop 1440x980 and mobile 390x844 |

## Screenshots

All four are single-viewport captures produced by `relabeld verify`; no manual screenshots, no
image editing. Before is the unpatched upstream deployment (Uptime Kuma's setup/outdated notice
page); after is the patched deployment's login page.

| Viewport | Before | After |
|---|---|---|
| Desktop 1440x980 | [before-desktop-1440x980.png](../demo/shots/before-desktop-1440x980.png) | [after-desktop-1440x980.png](../demo/shots/after-desktop-1440x980.png) |
| Mobile 390x844 | [before-mobile-390x844.png](../demo/shots/before-mobile-390x844.png) | [after-mobile-390x844.png](../demo/shots/after-mobile-390x844.png) |

The pairs compare the brand surface, not the page state: product name, `<title>`, palette, logo,
favicon, and the container/service naming from the compose override. The unpatched pair was captured
from the deployment before the patched image replaced it; the rebranded pair is the login page the
gate actually verified, so the numbers below describe the after state.

## Verification result

The demo's gate run is stored as raw JSON and as the rendered report:

| Artifact | Path |
|---|---|
| Verify result (JSON) | [demo/reports/verify.json](../demo/reports/verify.json) |
| Self-contained HTML report | [demo/reports/report.html](../demo/reports/report.html) |
| Demo run notes | [demo/reports/README.md](../demo/reports/README.md) |
| Brand spec used | [demo/reports/brand.yaml](../demo/reports/brand.yaml) |

The check set and its pass conditions are defined in [verification.md](verification.md). The rule for
this gallery is the same as for any run: the demo counts as done only if `verify.json` shows
`summary.failed === 0`.

## How it was produced

```bash
# 1. detect brand surfaces in the upstream checkout (read-only)
relabeld scan ./uptime-kuma-src --json > scan.json

# 2. write the brand spec
relabeld init ./uptime-kuma-src --name "Nova Status" --domain status.muneebs.space \
  --primary "#0f766e" --logo public/icon.svg --favicon public/favicon.ico

# 3. inspect then apply
relabeld apply ./uptime-kuma-src --dry-run
relabeld apply ./uptime-kuma-src

# 4. rebuild the app image from the patched source and recreate the container
docker compose -f docker-compose.yml -f docker-compose.relabel.yml up -d --build

# 5. prove the served page, keep the JSON and screenshots
relabeld verify --url https://status.muneebs.space \
  --brand ./uptime-kuma-src/brand.yaml \
  --shots demo/shots --json --out demo/reports/verify.json

# 6. render the proof
relabeld report --input demo/reports/verify.json --out demo/reports/report.html
```

Notes from the actual run:

- The `before` pair was captured from the unpatched deployment, then `apply` plus a source rebuild
  produced the patched deployment and the `after` pair. Both pairs use the same gate viewports.
- The image is rebuilt from the patched source because Uptime Kuma serves its UI from a build step;
  patching source files alone does not change the served page.
- `verify` runs against the served app, so the container must be recreated before the gate is
  meaningful.
- The demo brand is fictional and the demo is a private instance. The screenshots are committed so the
  gallery works offline.

## Re-running the demo

The commands above are the whole procedure. For a public fork, start from the upstream project's own
install instructions, then replace step 1-3 with your app paths. If the app is not covered by a
recipe, `scan` still finds its brand surfaces; add a recipe to record that knowledge for the next
upgrade (in v0.1.0 recipes are validated data, not yet consumed automatically by `scan`/`apply`).

One warning worth repeating: `relabeld` never removes upstream license, copyright, or attribution
text, and this demo keeps Uptime Kuma's license and notices intact. Rebranding does not change the
upstream license obligations, and the upstream trademark policy still applies if you expose the
rebranded instance to third parties.
