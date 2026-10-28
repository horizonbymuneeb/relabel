# relabeld

White-label a self-hosted app from one `brand.yaml`, then prove the result in a headless browser.

`relabeld` scans an app for the places its old name lives (strings, configs, docs, CI, env defaults,
logos, favicons), writes one brand spec, patches the app deterministically, and verifies the served
result: no old-brand strings in the rendered page, the new name in `<title>`, no console errors, no
horizontal overflow at desktop and mobile widths, screenshots on disk, and a favicon hash match.
Patching is deterministic: same input, same replacements. No model is in the loop.

```bash
relabeld scan ./app --json                 # read-only: what would change
relabeld init --name "Nova Status" --domain status.example.com
relabeld apply --dry-run                   # show the plan, write nothing
relabeld apply                             # patch strings, assets, env, compose
relabeld verify --url https://status.example.com --brand brand.yaml --json
relabeld report --input verify.json --out report.html
```

Status: v0.1.0. Every command in the table below is implemented: `scan`, `init`, `apply`, `verify`,
`report`, `recipe`, `deploy`, `doctor`, `mcp`, and `skill`. The test suite and the commands shown in
this README exercise the same code paths.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Verification](#verification)
- [Agent integrations](#agent-integrations)
- [Recipes](#recipes)
- [Deploy](#deploy)
- [What relabeld does not do](#what-relabeld-does-not-do)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js >= 20 (the CLI is plain ESM, no build step at runtime).
- A headless Chromium for `verify`. The launcher tries `RELABEL_CHROME`, then
  `/usr/bin/chromium-browser`, then `/usr/bin/google-chrome`; alternatively point it at an existing
  DevTools endpoint with `--cdp`.
- Optional, only for `deploy --apply`: nginx, systemd, certbot, and root access.

## Install

From npm:

```bash
npm install -g relabeld
relabeld --version
```

From source (this repository):

```bash
git clone https://github.com/horizonbymuneeb/relabel
cd relabel
npm ci
npm run build
node dist/cli.js --help        # same CLI, run straight from dist/
```

The package exposes one binary, `relabeld` (`dist/cli.js`). Run `relabeld <command> --help` for each
command's flags. Global options go before the command:

```bash
relabeld --cwd /srv/app verify --url https://status.example.com --brand brand.yaml
```

## Quickstart

```bash
# 1. See what the app calls itself. Read-only unless --save is passed.
relabeld scan ./app --json > scan.json

# 2. Write brand.yaml (name, domain, palette, logo, favicon, email sender).
#    Detected upstream variants are recorded as `variants` so verification can look for them.
relabeld init ./app --name "Nova Status" --domain status.example.com \
  --primary "#0f766e" --logo public/logo.svg --favicon public/favicon.svg

# 3. Inspect the plan, then apply it. `apply` never rewrites license/attribution files or lines.
relabeld apply ./app --brand ./app/brand.yaml --dry-run
relabeld apply ./app --brand ./app/brand.yaml

# 4. Start the app with the generated compose override, if one was written, then
#    verify the served page, not the source tree.
relabeld verify --url http://127.0.0.1:3001 --brand ./app/brand.yaml --json --out verify.json

# 5. Turn the proof into one self-contained HTML file (images embedded, no external requests).
relabeld report --input verify.json --out report.html
```

`apply` is idempotent: a second run reports zero changes. `verify` exits `0` only when all seven
checks pass; see [Verification](#verification). The full walkthrough, including the compose
override and CI wiring, is in [docs/quickstart.md](docs/quickstart.md).

## Commands

| Command | Flags | What it does |
|---|---|---|
| `scan` | `[dir] [--json] [--save]` | Detect brand surfaces: strings, configs, docs, CI, license lines, logo/favicon assets. Read-only unless `--save` writes `.relabel/scan.json` inside `[dir]`. |
| `init` | `[dir] --name <brand> [--domain <host>] [--primary <#hex>] [--accent <#hex>] [--logo <path>] [--favicon <path>] [--email-from <addr>] [--force] [--json]` | Write `brand.yaml` from the scan plus the given brand. Refuses to overwrite without `--force`. |
| `apply` | `[dir] [--brand <file>] [--dry-run] [--json]` | Patch strings (case-preserving, word-boundary), copy logo/favicon assets, write `docker-compose.relabel.yml`. Skips license files and copyright lines. |
| `verify` | `--url <URL> [--brand <file>] [--shots <dir>] [--cdp <endpoint>] [--out <file>] [--json]` | Headless proof: 7 checks, screenshots, exit code as the gate. Default brand file `brand.yaml`; default shots dir `.relabel/verify`. |
| `report` | `--input <verify.json> --out <report.html> [--json]` | Render a self-contained HTML report with inline CSS and base64 screenshots. |
| `recipe` | `<list \| show <id> \| add <path>> [--json] [--force]` | Work with the bundled per-app recipe library. `list` validates every recipe and exits non-zero if any is invalid. |
| `deploy` | `[dir] --brand <file> (--dry-run \| --apply) [--port <n>] [--certbot]` | Render an nginx vhost and optionally create a Cloudflare A record; `--apply` writes and reloads nginx. One mode is mandatory. |
| `mcp` | (none) | MCP stdio server exposing five tools: `relabel_scan`, `relabel_init`, `relabel_apply`, `relabel_verify`, `relabel_report`. |
| `skill` | `install --agent <claude\|codex\|dsh\|all> [--prefix <dir>] [--no-verify]` or `list` | Copy the bundled agent skill into the agent's skill root (`~/.claude/skills`, `~/.codex/skills`, `~/.dsh-home/skills`) and validate the install. |
| `doctor` | `[--json]` | Check the local environment: node, docker, chromium, nginx, certbot, Cloudflare token. Exits `1` when a required check (node, browser) fails. |

Exit codes: `0` success, `1` a check or step failed, `2` usage error (unknown flag, missing required
argument, missing deploy mode).

## Verification

`verify` opens the served app in headless Chromium at two viewports, runs seven checks, writes
screenshots, and exits non-zero if any check failed. The check set is the definition of done:

| id | Pass condition |
|---|---|
| `brand-strings` | 0 occurrences of any old-brand `variants` entry in the rendered DOM text or page HTML (case-insensitive). |
| `brand-title` | `document.title` contains the new brand name at both viewports. |
| `console-errors` | 0 `pageerror` events and 0 console messages of type `error`. |
| `overflow-desktop` | `scrollWidth - innerWidth === 0` at 1440x980. |
| `overflow-mobile` | Same at 390x844. |
| `screenshots` | `desktop.png` and `mobile.png` written to `--shots`. |
| `favicon` | Favicon responds 200 and its sha256 matches the brand asset in `brand.yaml`; skipped when no favicon is configured. |

Screenshots are viewport-sized PNGs (not full-page). Verification runs against the deployed app, so
rebuild and redeploy first. Reference for the check semantics and exit codes:
[docs/verification.md](docs/verification.md).

## Agent integrations

- **MCP:** `relabeld mcp` serves five tools over stdio; each tool call runs the same CLI with
  `--json`, so MCP results and CLI output are the same data. Configuration and parameter tables:
  [docs/agents.md](docs/agents.md).
- **Skill:** `relabeld skill install --agent claude|codex|dsh|all` installs the bundled `relabel`
  skill (SKILL.md plus references) and validates frontmatter and references after copying.
- **CI:** the repository ships a composite GitHub Action and the direct CLI gate
  (`verify --json --out verify.json`), so any CI system can gate on the same seven checks. Inputs,
  fail-on policy and artifact wiring: [docs/agents.md](docs/agents.md).
- **Any other harness:** the core is a plain CLI with JSON output and stable exit codes, so a shell
  step is enough.

## Recipes

A recipe is one directory under `recipes/<id>/recipe.yaml` and encodes the per-app knowledge a
deterministic rebrand needs: which strings identify the app, which asset targets to replace, env
defaults, compose service/port, and verification defaults.

```bash
relabeld recipe list
relabeld recipe show uptime-kuma
relabeld recipe add ./my-recipe
relabeld recipe list --json
```

The recipe library lives next to the installed package (`recipes/`); `RELABELD_RECIPES_DIR`
overrides it. In v0.1.0 the CLI validates, lists, shows and installs recipes; `scan` and `apply` do
not consume recipe files automatically yet. The variant knowledge that drives patching and
verification lives in `brand.yaml` (`init` records the scan's `brandTokens` as `variants`). Format,
validation rules, and contribution steps: [docs/recipe-spec.md](docs/recipe-spec.md).

## Deploy

`deploy` is opt-in and refuses to run without an explicit mode:

```bash
relabeld deploy --brand brand.yaml --dry-run --port 3001   # print the vhost + commands, write nothing
relabeld deploy --brand brand.yaml --apply --port 3001     # write vhost, enable, reload nginx
relabeld deploy --brand brand.yaml --apply --certbot       # also run the printed certbot command
```

The vhost is rendered to `$RELABEL_NGINX_DIR/<domain>.conf` (default `/etc/nginx/sites-available`)
and linked into `$RELABEL_NGINX_ENABLED_DIR` (default `/etc/nginx/sites-enabled`). Cloudflare DNS is
create-only and needs `CF_DNS_ADMIN_TOKEN`, `CF_ZONE_ID`, and `CF_ZONE_NAME`; `CF_DNS_IP` overrides
the detected public IPv4. Nothing is deleted.

## What relabeld does not do

- It does not strip license, copyright, or attribution text. License files and copyright/SPDX lines
  are skipped by `apply`, and `brand.keep` entries are never rewritten. White-labelling does not
  change your obligations under the upstream license; check the upstream trademark policy before
  offering a rebranded instance to third parties.
- It does not decide what "correct" means. `verify` reports what it measured; the seven checks are
  the contract.
- It does not guess per-app knowledge. `scan` is generic; recipes are validated records, not
  executable hooks, and v0.1.0 does not consume them automatically. If a surface needs an exact rule,
  handle it in the brand spec or a follow-up patch rather than expecting magic.
- It does not touch the system unless asked: `deploy` requires `--dry-run` or `--apply`, and
  `apply --dry-run` performs no writes.

## Docs

| Document | Contents |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | End-to-end walkthrough: install, scan, init, apply, serve, verify, report, CI. |
| [docs/verification.md](docs/verification.md) | The seven checks, exit codes, browser/CDP options. |
| [docs/agents.md](docs/agents.md) | MCP tools, skill installer, GitHub Action and CI gate. |
| [docs/recipe-spec.md](docs/recipe-spec.md) | Recipe format, validation rules, contributing a recipe. |
| [docs/demo-gallery.md](docs/demo-gallery.md) | The worked demo: before/after screenshots and the verification result. |
| [demo/site/index.html](demo/site/index.html) | Static gallery page for the demo artifacts (no build step, no external assets). |

## Contributing

1. `npm ci && npm run build && npm test` must pass.
2. Tests live in `test/` (`node --test test/`); fixtures live in `test/fixtures/`.
3. Recipes are data only: model a new one on `recipes/uptime-kuma/recipe.yaml`, then run
   `relabeld recipe show <id>` to validate it.
4. Keep public docs matching the implemented CLI. If a command is still a stub, mark it planned.

## License

MIT. See [LICENSE](LICENSE).
