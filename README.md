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

Status: v1.0.0. Every command in the table below is implemented: `scan`, `init`, `apply`, `verify`,
`report`, `recipe`, `deploy`, `doctor`, `mcp`, and `skill`. The test suite and the commands shown in
this README exercise the same code paths. Release notes: [CHANGELOG.md](https://github.com/horizonbymuneeb/relabel/blob/main/CHANGELOG.md).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Verification](#verification)
- [Agent integrations](#agent-integrations)
- [Recipes](#recipes)
- [Deploy](#deploy)
- [License and attribution](#license-and-attribution)
- [What relabeld does not do](#what-relabeld-does-not-do)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js >= 20 (the CLI is plain ESM, no build step at runtime).
- A headless Chromium for `verify`. The launcher tries `RELABEL_CHROME` (or `RELABEL_CHROMIUM_PATH`,
  used by the Docker image), then `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`, and
  `/usr/bin/chromium`; alternatively point it at an existing DevTools endpoint with `--cdp`.
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

`apply` is idempotent: a second run reports zero changes. `verify` exits `0` when no check failed (a
skipped check, such as an unconfigured favicon, does not fail the gate); see [Verification](#verification). The full walkthrough, including the compose
override and CI wiring, is in [docs/quickstart.md](docs/quickstart.md).

## Commands

| Command | Flags | What it does |
|---|---|---|
| `scan` | `[dir] [--json] [--save] [--max-file-bytes <n>]` | Detect brand surfaces: strings, configs, docs, CI, license lines, logo/favicon assets. Read-only unless `--save` writes `.relabel/scan.json` inside `[dir]`. Files over `--max-file-bytes` (default 524288) are reported as skipped. |
| `init` | `[dir] --name <brand> [--from <dir>] [--domain <host>] [--primary <#hex>] [--accent <#hex>] [--logo <path>] [--favicon <path>] [--email-from <addr>] [--force] [--json]` | Write `brand.yaml` from the scan plus the given brand. `--from` is an alias for the positional directory. Refuses to overwrite without `--force`. |
| `apply` | `[dir] [--brand <file>] [--recipe <id\|path>] [--dry-run] [--max-file-bytes <n>] [--json]` | Patch strings (case-preserving, word-boundary), copy logo/favicon assets, apply recipe file renames, write `docker-compose.relabel.yml`. Skips license files and copyright lines, never rewrites docker image refs, and reports oversize/binary/non-UTF-8 files as skipped instead of partially patching them. |
| `verify` | `--url <URL> [--brand <file>] [--shots <dir>] [--cdp <endpoint>] [--executable <path>] [--out <file>] [--json]` | Headless proof: 7 checks, screenshots, exit code as the gate. Default brand file `brand.yaml`; default shots dir `.relabel/verify`. |
| `report` | `--input <verify.json> --out <report.html> [--json]` | Render a self-contained HTML report with inline CSS and base64 screenshots. |
| `recipe` | `<list \| show <id> \| add <path>> [--json] [--force]` | Work with the bundled per-app recipe library. `list` validates every recipe and exits non-zero if any is invalid. |
| `deploy` | `[dir] --brand <file> (--dry-run \| --apply) [--port <n>] [--force] [--certbot]` | Render an nginx vhost and optionally create a Cloudflare A record; `--apply` writes and reloads nginx. Existing certbot-managed TLS vhosts are preserved unless `--force`. One mode is mandatory. |
| `mcp` | (none) | MCP stdio server exposing five tools: `relabel_scan`, `relabel_init`, `relabel_apply`, `relabel_verify`, `relabel_report`. |
| `skill` | `install --agent <claude\|codex\|dsh\|all> [--prefix <dir>] [--no-verify]` or `list` | Copy the bundled agent skill into the agent's skill root (`~/.claude/skills`, `~/.codex/skills`, `~/.dsh-home/skills`) and validate the install. |
| `doctor` | `[--json]` | Check the local environment: node, docker, chromium, nginx, certbot, Cloudflare token. Exits `1` when a required check (node, browser) fails. |

Exit codes: `0` no failures (skipped checks are reported; use `--json` to see them), `1` at least one
check or step failed, `2` usage error (unknown flag, missing required argument, missing deploy mode).

## Verification

`verify` opens the served app in headless Chromium at two viewports, runs seven checks, writes
screenshots, and exits non-zero if any check failed. The check set is the definition of done:

| id | Pass condition |
|---|---|
| `brand-strings` | 0 visible occurrences of any old-brand `variants` entry in rendered text, the title, or page HTML (case-insensitive; text deduped across viewports). A line is exempt only under the shared license/attribution rule (`copyright`, `©`, `(c)` + 4-digit year, `SPDX-License-Identifier`, `all rights reserved`, `licensed under`) or if it contains a `brand.keep` entry; other `license:` text is stale branding and fails. Fails when no variants are configured. |
| `brand-title` | `document.title` contains the new brand name at both viewports. |
| `console-errors` | 0 `pageerror` events and 0 console messages of type `error`. Only Chromium's implicit `/favicon.ico` resource 404 is ignored (counted in the detail); any other 404, page error, or console error fails. |
| `overflow-desktop` | `scrollWidth - innerWidth <= 0` at 1440x980 (only positive overflow fails). |
| `overflow-mobile` | Same at 390x844. |
| `screenshots` | Viewport captures written to `--shots`: `desktop.png` at 1440x980 and `mobile.png` at 390x844 (not full-page). |
| `favicon` | The served HTML icon resolves to bytes (http(s) 200, or a decoded `data:` URI) whose sha256 matches a configured brand asset (`brand.favicon` or `brand.logo`); skipped when no brand asset is configured or a runtime-generated `data:` icon differs. |

Verification runs against the deployed app, so rebuild and redeploy first. A `skip` is reported in the
result but does not fail the gate; read `--json` to see pass/skip/fail per check. Reference for the
check semantics and exit codes: [docs/verification.md](docs/verification.md).

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
overrides it. `apply` consumes a recipe for file renames after a brand rename breaks
`require()`/`import` paths, and for the `files:` opt-in that allows rewriting docker image refs of a
specific file. The recipe is auto-detected from the app's `package.json` name or directory name;
`--recipe <id|path>` forces one. `scan`, `verify`, and `deploy` do not read recipes, and the
`strings`/`assets`/`env`/`compose`/`verify` recipe keys are recorded by `recipe show` but not consumed
by those commands. The variant knowledge that drives patching and verification lives in `brand.yaml`
(`init` records the scan's `brandTokens` as `variants`). Format, validation rules, and contribution
steps: [docs/recipe-spec.md](docs/recipe-spec.md).

## Deploy

`deploy` is opt-in and refuses to run without an explicit mode:

```bash
relabeld deploy --brand brand.yaml --dry-run --port 3001   # print the vhost + commands, write nothing
# note: --dry-run may query a public-IP lookup service when Cloudflare env vars are set (no writes)
relabeld deploy --brand brand.yaml --apply --port 3001     # write vhost, enable, reload nginx
relabeld deploy --brand brand.yaml --apply --certbot       # also run the printed certbot command
relabeld deploy --brand brand.yaml --apply --force         # rewrite a certbot-managed TLS vhost
```

`--apply` is idempotent. If the target vhost already carries certbot-managed TLS
(`ssl_certificate`/`listen 443 ssl`), it is preserved and the command says so instead of overwriting
it, because the template would drop the TLS block. Pass `--force` to rewrite it; a timestamped backup
of the old vhost is written first.

The vhost is rendered to `$RELABEL_NGINX_DIR/<domain>.conf` (default `/etc/nginx/sites-available`)
and linked into `$RELABEL_NGINX_ENABLED_DIR` (default `/etc/nginx/sites-enabled`). Cloudflare DNS is
create-only and needs `CF_DNS_ADMIN_TOKEN`, `CF_ZONE_ID`, and `CF_ZONE_NAME`; `CF_DNS_IP` overrides
the detected public IPv4. Nothing is deleted.

## License and attribution

`apply` preserves what the upstream license depends on: `LICENSE`/`COPYING`/`NOTICE` files are never
rewritten, copyright/SPDX lines are left untouched, and `brand.keep` protects extra attribution text
you list. It also rebrands package metadata (for example `package.json` author/contributors) and prose
attribution inside normally patchable files, so it is not a claim that nothing attributed is ever
touched. Keep the upstream license and notices in place, and use `brand.keep` for any attribution the
gate must treat as preserved. White-labelling does not change your obligations under the upstream
license; check the upstream trademark policy before offering a rebranded instance to third parties.

## What relabeld does not do
- It does not decide what "correct" means. `verify` reports what it measured; the seven checks are
  the contract.
- It does not guess per-app knowledge. `scan` is generic, recipes are validated data (no executable
  hooks), and `apply` only uses a recipe's `renames` and `files:` opt-ins. If a surface needs an exact
  rule, handle it in the brand spec or a follow-up patch rather than expecting magic.
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
| [demo/site/index.html](https://github.com/horizonbymuneeb/relabel/blob/main/demo/site/index.html) | Static gallery page for the demo artifacts (repo-only; not in the npm package). |

## Contributing

1. `npm ci && npm run build && npm test` must pass.
2. Tests live in `test/` (`node --test test/`); fixtures live in `test/fixtures/`.
3. Recipes are data only: model a new one on `recipes/uptime-kuma/recipe.yaml`, then run
   `relabeld recipe show <id>` to validate it.
4. Keep public docs matching the implemented CLI. Mark anything not implemented as planned instead
   of documenting imagined behaviour.

## License

MIT. See [LICENSE](LICENSE).
