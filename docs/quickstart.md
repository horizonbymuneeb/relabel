# Quickstart

This walkthrough takes a self-hosted app from "wearing the upstream name" to "verified white-label"
with the commands that exist in v1.0.2. Every command below was run against a fixture app and a
local HTTP server; the shape of the output is what you should see.

## 0. Prerequisites

- Node.js >= 20.
- A headless Chromium for `verify`: the launcher tries `RELABEL_CHROME` (or `RELABEL_CHROMIUM_PATH`),
  then `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`, and `/usr/bin/chromium`. If Chromium
  lives elsewhere, set `RELABEL_CHROME=/path/to/chrome` or pass `verify --executable /path/to/chrome`.
- The app source on disk, plus a way to run it (`docker compose up -d`, or a dev server).

Install relabeld:

```bash
npm install -g relabeld          # or: npm ci && npm run build in a source checkout
relabeld --version
```

In a source checkout the CLI is `node dist/cli.js`; the arguments are identical.

Check the environment before starting:

```bash
relabeld doctor
```

`doctor` prints one line per tool (node, docker, browser, nginx, certbot, Cloudflare token) and exits
`1` if a required check fails — node >= 20 and a chromium/chrome binary. The deploy-only tools being
missing is a `warn`, not a failure. `relabeld doctor --json` returns `{ checks[], ok }`.

## 1. Scan the app

```bash
cd /srv
relabeld scan ./my-app --json > scan.json
```

`scan` is read-only. It reports `scannedFiles`, the `brandTokens` it considers the app's own name,
`findings` (file, line, kind, token, match, confidence, suggestion), detected `assets` (logo,
favicon, og-image with sizes and sha256), per-kind `summaries`, and `skipped` files (with
`maxFileBytes`). The scan skips build and vendor
directories (`node_modules`, `dist`, `build`, `.venv`, `target`, `coverage`, ...) and hidden
directories except CI ones (`.github`, `.gitlab`, `.circleci`, `.devcontainer`, `.vscode`).

Useful variants:

```bash
relabeld scan ./my-app --save                  # also writes ./my-app/.relabel/scan.json
relabeld scan ./my-app                         # human summary
relabeld scan ./my-app --max-file-bytes 262144 # lower the per-file read limit
```

Files larger than `--max-file-bytes` (default 524288 bytes) are reported as skipped rather than read
partially.

If the app is already covered by a bundled recipe, `relabeld recipe show <id>` tells you what the
recipe knows; `scan` still works the same way.

## 2. Write `brand.yaml`

```bash
relabeld init ./my-app \
  --name "Nova Status" \
  --domain status.example.com \
  --primary "#0f766e" \
  --accent "#111827" \
  --logo brand/logo.svg \
  --favicon brand/favicon.svg \
  --email-from "hello@status.example.com"
```

| Flag | Required | Meaning |
|---|---|---|
| `--name <text>` | yes | New brand name, used verbatim in titles, env defaults, and the compose override. |
| `--from <dir>` | no | Source directory, as an alias for the positional `[dir]` (the positional wins if both are given). |
| `--domain <host>` | no | Public domain; used by `deploy` and recorded in the spec. |
| `--primary <#hex>` | no | Primary colour, default `#2563EB`. |
| `--accent <#hex>` | no | Accent colour. |
| `--logo <path>` | no | Your new logo asset, resolved against the app dir then the cwd. Copied over detected logo targets by `apply`. |
| `--favicon <path>` | no | Your new favicon asset (any format the app serves). Also enables the favicon check in `verify`. |
| `--email-from <addr>` | no | Sender address for generated config; `deploy --certbot` reuses it for the ACME account. |
| `--force` | no | Overwrite an existing `brand.yaml`. |
| `--json` | no | Print `{ path, brand }` instead of the human summary. |

`init` scans the app and derives two things you would otherwise get wrong:

- `variants` — the upstream names to look for at verification time.
- `keep` — files that must never be rewritten (`LICENSE`, `NOTICE`, `COPYING`, and every file `scan`
  classified as a license/attribution file).

The written file looks like this:

```yaml
name: Nova Status
palette:
  primary: "#0f766e"
  accent: "#111827"
variants:
  - Acme Status
keep:
  - LICENSE
  - NOTICE
  - COPYING
domain: status.example.com
emailFrom: hello@status.example.com
logo: brand/logo.svg
favicon: brand/favicon.svg
```

`init` does not modify the app. All edits happen in `apply`.

If the app is covered by a bundled recipe (for example `uptime-kuma`), `init` behaves the same way;
the recipe is picked up by `apply`, not by `init`.

## 3. Apply the brand

```bash
relabeld apply ./my-app --brand ./my-app/brand.yaml --dry-run
```

Dry-run writes nothing and prints the full plan:

```
relabeld apply — /srv/my-app
brand: Nova Status (/srv/my-app/brand.yaml)
recipe: none (pass --recipe <id> to enable file renames)
mode: DRY-RUN — no files written

changed 9 files, 22 replacements
  docker-compose.yml                         3
  index.html                                 5
  package.json                               2
  README.md                                  3
  ...

skipped 3:
  docker-compose.yml                         docker image ref preserved (FROM/image) (1 lines)
  index.html                                 copyright/license line preserved (1 lines)
  LICENSE                                    license file — attribution preserved

assets would copy:
  logo     public/logo.svg                      ← public/logo.svg (312 B)
  favicon  public/favicon.svg                   ← public/favicon.svg (197 B)

compose would write: docker-compose.relabel.yml (service acme-status → nova-status)
would run: docker compose -f docker-compose.yml -f docker-compose.relabel.yml up -d
```

Then apply for real:

```bash
relabeld apply ./my-app --brand ./my-app/brand.yaml
relabeld apply ./my-app --brand ./my-app/brand.yaml --json
```

If the app is covered by a recipe, `apply` auto-detects it from `package.json`/directory name (or use
`--recipe <id|path>`) and adds a rename phase after the text patch. Example on an Uptime Kuma-shaped
tree:

```
relabeld apply — /srv/uptime-kuma
brand: Nova Status (/srv/uptime-kuma/brand.yaml)
recipe: uptime-kuma (auto-detected: .../recipes/uptime-kuma/recipe.yaml)
mode: DRY-RUN — no files written

changed 5 files, 8 replacements
  ...
renames planned 1:
  server/uptime-kuma-server.js                   → server/nova-status-server.js                   would-rename

skipped 2:
  docker-compose.yml                         docker image ref preserved (FROM/image) (1 lines)
  Dockerfile                                 docker image ref preserved (FROM/image) (1 lines)

compose would write: docker-compose.relabel.yml (service uptime-kuma → nova-status)
would run: docker compose -f docker-compose.yml -f docker-compose.relabel.yml up -d
```

The rename runs before the app is started, so rewritten `require("./uptime-kuma-server")` references
resolve to the new filename. Docker image references (`FROM ...`, `image: ...`) are not rewritten
unless the recipe has a `files:` rule for that file; this keeps upstream image namespaces intact.

Behaviour you can rely on:

- Replacements are word-boundary and case-preserving: `Acme Status` → `Nova Status`,
  `acme-status` → `nova-status`, `ACME-STATUS` → `NOVA-STATUS`.
- Recipe-driven file renames happen after the text patch and are idempotent; a re-run reports the
  rename as already done instead of renaming twice.
- Docker `FROM`/`image:` references are never rewritten implicitly.
- Oversize files, binary files, and text files that are not valid UTF-8 are reported as skipped and
  left untouched; `--max-file-bytes <n>` changes the limit (default 524288).
- `brand.yaml` itself and the generated override are never rewritten.
- License files and copyright/license lines are skipped; `brand.keep` entries are protected.
- The configured logo/favicon is copied over every detected asset target of that kind.
- A `docker-compose.relabel.yml` override is generated from the pristine compose file (service name,
  container name, `APP_NAME`, labels).
- Re-running is idempotent; a second `apply --json` reports `"changed": []`.

Bring the app up with the override so the new name reaches the runtime environment:

```bash
docker compose -f docker-compose.yml -f docker-compose.relabel.yml up -d
```

If the app serves a prebuilt bundle (Vite, webpack, a Go/Rust binary), rebuild it before recreating
the container; patching source files alone does not change a served build. The demo in
[demo-gallery.md](demo-gallery.md) does exactly that rebuild between `apply` and `verify`.

## 4. Serve the app

Verification runs against the **served app**, not the source tree. Pick one path:

- Compose (above), then note the published port.
- `relabeld deploy --brand brand.yaml --dry-run` to render the nginx vhost and the exact commands;
  `--apply` writes the vhost, enables it, and reloads nginx (opt-in, root required). An existing
  certbot-managed TLS vhost is preserved unless you add `--force`, which writes a timestamped backup
  before overwriting.

## 5. Verify

```bash
relabeld verify \
  --url http://127.0.0.1:3001 \
  --brand ./my-app/brand.yaml \
  --shots .relabel/verify \
  --out verify.json
```

Output:

```
STATUS  CHECK             DETAIL
PASS    brand-strings     0 occurrences across 1 old-brand variant (rendered text + HTML)
PASS    brand-title       desktop: "Nova Status"; mobile: "Nova Status"
PASS    console-errors    0 page errors, 0 console errors
PASS    overflow-desktop  scrollWidth 1440 − innerWidth 1440 = 0
PASS    overflow-mobile   scrollWidth 390 − innerWidth 390 = 0
PASS    screenshots       saved desktop (20356 bytes), mobile (16128 bytes) in .relabel/verify
PASS    favicon           HTTP 200, sha256 dc416a69… matches status.example.com/favicon.svg

7 passed, 0 failed, 0 skipped
```

- Screenshots are `desktop.png` and `mobile.png` in `--shots` (default `.relabel/verify`), taken at
  1440x980 and 390x844.
- `--json` prints exactly one `VerifyResult` object on stdout; `--out` also writes it to a file.
- `--cdp http://127.0.0.1:9223` reuses an existing Chromium instead of launching one.
- `--executable /path/to/chrome` launches a specific browser binary; `RELABEL_CHROME` sets the same
  default through the environment (`RELABEL_CHROMIUM_PATH` is an accepted alias, used by the Docker
  image).
- An implicit `/favicon.ico` 404 is tolerated in the console check and reported as
  `(ignored 1 implicit /favicon.ico 404)`; the favicon check itself still fails an explicit 404.
- `brand-strings` ignores old-brand text only on license/attribution lines (same rule as
  `scan`/`apply`: `copyright`, `©`, `(c)` + 4-digit year, `SPDX-License-Identifier`,
  `all rights reserved`, `licensed under`) and on `brand.keep` lines, reporting the ignored count in
  the detail. Visible occurrences still fail, and a plain `license: Old Name` line is treated as stale
  branding, not attribution.

## 6. Render the report

```bash
relabeld report --input verify.json --out report.html
```

The report is one self-contained HTML file: inline CSS, base64 screenshots, no external requests, so
it can be attached to a ticket, committed as a build artifact, or emailed.

## 7. Gate CI on it

```bash
relabeld verify --url "$APP_URL" --brand brand.yaml --json --out verify.json
relabeld report --input verify.json --out report.html
```

`verify` exits `0` when there are no failures; skipped checks are reported in the result (`--json`), so
the first command is the gate. See
[docs/agents.md](agents.md) for the composite GitHub Action and the MCP wrapper, and
[docs/verification.md](verification.md) for check semantics.

## Global options and exit codes

Global options go before the command:

```bash
relabeld --cwd /srv/my-app verify --url http://127.0.0.1:3001 --brand brand.yaml
relabeld --json scan ./my-app
```

| Exit code | Meaning |
|---|---|
| `0` | Success (for `verify`: every check passed or skipped). |
| `1` | A check or step failed (`verify` failures, `apply` unable to find its brand file, deploy failure, invalid recipe library). |
| `2` | Usage error: missing required flag, unknown option, missing `deploy` mode. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `could not launch headless Chromium` | No known browser binary. Set `RELABEL_CHROME=/path/to/chrome`, pass `verify --executable <path>`, or use `--cdp`. |
| `verify: --url is required` (exit 2) | `verify` has no default URL; pass the URL of the running app. |
| `brand-strings` fails with `"Old Name" ×N` | The served page still contains an upstream variant. Rebuild/redeploy after `apply`; if the string is data (not UI), add it to the recipe or fix the runtime config. |
| `favicon` is `SKIP` | Either `brand.yaml` configures no `favicon:`/`logo:` (add one and re-run), the page's icon is a runtime-generated `data:` URI whose bytes differ from the brand asset, or the scheme is not http(s)/data:. A skip does not fail the gate. |
| `favicon` fails with `HTTP 404` | The served HTML points at an icon path the deployment does not ship. Fix the asset path or configure `brand.favicon`/`brand.logo` to the bytes the app actually serves. |
| `favicon` fails with a hash mismatch | The served favicon is not the file `brand.yaml` points at; rebuild the app image or copy the asset. |
| Overflow fails | Only positive overflow fails. `verify` reports `scrollWidth - innerWidth`; if the value is positive the page really does overflow at that viewport, so fix the layout or reduce width. |
| `brand.yaml already exists` | Pass `--force` to `init`, or edit the existing spec. |
| `brand-strings` flags a `license: Old Name` line | That is not a license line under the shared rule (only `copyright`, `©`, `(c) YYYY`, `SPDX-License-Identifier`, `all rights reserved`, `licensed under` are exempt); fix the value or add the line/string to `brand.keep`. |
| `verify: cannot read brand spec` (exit 2) | Wrong path; `--brand` resolves against the cwd. |
| `apply: brand file not found` | Run `init` first, or pass `--brand <path>`. |
| `apply: recipe not found` | `--recipe` accepts a recipe id in the library, a path to `recipe.yaml`, or a directory; omit the flag to auto-detect from the app. |
| `verify: Unknown option '--cwd'` | `verify` parses strictly, so global options must come before the command for it: `relabeld --cwd DIR verify ...`. |
| `doctor` reports `FAIL` | A required check failed: node older than 20 or no chromium/chrome binary. Fix that first; deploy-only warnings (nginx, certbot, Cloudflare token) do not fail the command. |
