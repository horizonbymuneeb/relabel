# Demo gallery

A worked example of the full loop on a real app: **Uptime Kuma 1.23.17**, rebuilt from source and
white-labelled as **Nova Status**, then verified by `relabeld` v1.0.0 in headless Chromium. The
static page is [demo/site/index.html](../demo/site/index.html); it is self-contained and links only
files in this repository.

| | |
|---|---|
| Source app | Uptime Kuma 1.23.17 (self-hosted status page) |
| Demo brand | Nova Status (fictional) |
| Hosted at | `status.muneebs.space` |
| Gate | `relabeld verify`: seven checks, exit code as the verdict |
| Captured with | headless Chromium via `verify`, desktop 1440x980 and mobile 390x844 |
| Result | 7 passed, 0 failed, 0 skipped |

## Screenshots

All four are single-viewport captures produced by `relabeld verify`; no manual screenshots, no
image editing. Before is the unpatched upstream deployment (Uptime Kuma's setup/outdated notice
page); after is the patched deployment's login page.

| Viewport | Before | After |
|---|---|---|
| Desktop 1440x980 | [before-desktop-1440x980.png](../demo/shots/before-desktop-1440x980.png) | [after-desktop-1440x980.png](../demo/shots/after-desktop-1440x980.png) |
| Mobile 390x844 | [before-mobile-390x844.png](../demo/shots/before-mobile-390x844.png) | [after-mobile-390x844.png](../demo/shots/after-mobile-390x844.png) |

The pairs compare the brand surface, not the page state: product name, `<title>`, logo, favicon, and
the container/service naming from the compose override. The unpatched pair was captured from the
deployment before the patched image replaced it; the rebranded pair is the login page the gate
actually verified, so the numbers below describe the after state.

The status-page palette (`#2563EB`) is applied to the app's status-page accent config, not to the
login theme; the upstream green login button is unchanged on purpose. Do not read the after pair as a
fully re-themed UI.

## Verification result

The demo's gate run is stored as raw JSON and as the rendered report:

| Artifact | Path |
|---|---|
| Verify result (JSON) | [demo/reports/verify.json](../demo/reports/verify.json) |
| Self-contained HTML report | [demo/reports/report.html](../demo/reports/report.html) |
| Demo run notes | [demo/reports/README.md](../demo/reports/README.md) |
| Brand spec used | [demo/reports/brand.yaml](../demo/reports/brand.yaml) |

The committed run (generated `2026-10-29T00:02:53Z`) reports **7 passed, 0 failed, 0 skipped**:

| Check | Status |
|---|---|
| `brand-strings` | pass — 0 occurrences across 3 old-brand variants in rendered text + HTML |
| `brand-title` | pass — desktop and mobile title `Nova Status - Login` |
| `console-errors` | pass — 0 page errors, 0 console errors |
| `overflow-desktop` | pass — `scrollWidth 1440 - innerWidth 1440 = 0` |
| `overflow-mobile` | pass — `scrollWidth 390 - innerWidth 390 = 0` |
| `screenshots` | pass — desktop and mobile PNGs saved |
| `favicon` | pass — HTTP 200, sha256 matches the brand asset (`status.muneebs.space/icon.svg`) |

The numbers come from `demo/reports/verify.json`, produced by the verify command below against the
live deployment; `demo/reports/report.html` is the rendered form of that same JSON. The check set and
pass conditions are defined in [verification.md](verification.md), and the rule for this gallery is
the same as for any run: the demo counts as done only if `summary.failed === 0`.

## How it was produced

```bash
# 1. detect brand surfaces in the upstream checkout (read-only)
relabeld scan ./uptime-kuma-src --json > scan.json

# 2. write the brand spec
relabeld init ./uptime-kuma-src --name "Nova Status" --domain status.muneebs.space \
  --primary "#2563EB" --logo public/icon.svg --favicon public/favicon.ico

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

- The `before` pair was captured from the unpatched deployment (phase A), then `apply` plus a source
  rebuild produced the patched deployment and the `after` pair. Both pairs use the same gate
  viewports; `verify` writes `desktop.png`/`mobile.png`, which are kept under the `after-*` names for
  the paired gallery layout.
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
upgrade (`apply` consumes recipe file renames and `files:` opt-ins; `scan` does not read recipes).

One warning worth repeating: `relabeld` never removes upstream license, copyright, or attribution
text, and this demo keeps Uptime Kuma's license and notices intact. Rebranding does not change the
upstream license obligations, and the upstream trademark policy still applies if you expose the
rebranded instance to third parties.
