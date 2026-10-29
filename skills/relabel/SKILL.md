---
name: relabel
description: White-label a self-hosted app, then prove it headlessly.
version: 1.0.0
author: Muneeb Anjum
license: MIT
platforms: [linux, macos, windows]
---

# relabeld — deterministic white-labelling with proof

`relabeld` is a plain CLI that scans a self-hosted app for brand surfaces, applies a new brand
from one `brand.yaml`, and proves the result in headless Chromium. It is deterministic: recipes
encode per-app knowledge, verification is a hard gate, and no model is in the loop.

Use it when an app must stop wearing someone else's name — status pages, dashboards, self-hosted
SaaS — and when "done" has to mean measured, not eyeballed.

## When to Use

- Rebranding or white-labelling a self-hosted app before exposing it to users.
- Gating a deployment on real proof: zero old-brand strings, zero console errors, zero overflow.
- Producing a shareable verification report for a customer or auditor.
- Exposing relabel to an MCP-speaking agent (`relabeld mcp`) or installing this skill for
  Claude Code, Codex, or DSH (`relabeld skill install`).

Don't use for: cosmetic CSS tweaks inside one page, or for apps whose upstream license/trademark
policy forbids rebranding. `relabeld` never strips license or attribution text.

## Prerequisites

- Node.js >= 20 (`node --version`).
- A headless Chromium for `verify`. Launch order: `RELABEL_CHROME`, `/usr/bin/chromium-browser`,
  `/usr/bin/google-chrome`; or attach to an existing browser with `verify --cdp <ws-url>`.
- The app reachable at a URL (deployed or local).
- Install options:
  - `npx relabeld <command>` (no install), or
  - `npm i -g relabeld`, or
  - `relabeld skill install --agent claude|codex|dsh|all` to install this skill into
    `~/.claude/skills`, `~/.codex/skills`, `~/.dsh-home/skills` (or `--prefix <dir>`).

## Quick Reference

```bash
relabeld scan ./app --json                 # read-only detection of brand surfaces
relabeld init --name "Nova Status" --domain status.example.com
relabeld apply --dry-run                   # show changes, write nothing
relabeld apply                             # patch strings, assets, env, compose
relabeld verify --url https://status.example.com --brand brand.yaml --shots .relabel/verify
relabeld report --input verify.json --out report.html
relabeld recipe list
relabeld recipe show uptime-kuma
relabeld doctor
relabeld deploy --dry-run                  # nginx vhost + Cloudflare DNS + cert
relabeld mcp                               # MCP stdio server, 5 tools
relabeld skill install --agent all
```

Global flags: `--json` (exactly one JSON object on stdout), `--cwd <dir>`. Exit codes: `0` ok
(or no failed checks), `1` check/command failure (verify failures, refused writes, deploy errors),
`2` usage error.

## Procedure

1. **Scan.** Run `relabeld scan <dir> --json`. Completion: a `ScanResult` with `findings[]`,
   `brandTokens[]`, and `assets[]`; nothing was modified.
2. **Write the brand.** Run `relabeld init --name "<Brand>" --domain <domain>` (or edit the
   generated `brand.yaml`). A brand spec has `name`, `domain`, `palette.{primary,accent,background}`,
   `logo`, `favicon`, `emailFrom`, `variants` (old brand strings to eliminate, case-insensitive),
   and `keep` (strings that must survive, e.g. license references). Completion: `brand.yaml`
   parses and `variants` covers every upstream name you intend to remove.
3. **Apply.** Run `relabeld apply --dry-run`, review the diff, then `relabeld apply`. Completion:
   the app builds/starts locally with the new brand.
4. **Verify.** Run
   `relabeld verify --url <url> --brand brand.yaml --shots .relabel/verify --json` and require
   exit `0`. Completion: all seven checks report `pass` or an expected `skip` (favicon only when
   `brand.favicon` is unset).
5. **Report.** Run `relabeld report --input verify.json --out report.html`. Completion: one
   self-contained HTML file — inline CSS, base64 screenshots, zero external references — that
   opens offline.
6. **Deploy.** Only after verification passes: `relabeld deploy --dry-run` then `relabeld deploy`.
   Keep provider credentials in env vars, never in `brand.yaml`.

### Verification matrix (the hard gate)

| Check id | Pass condition |
|---|---|
| `brand-strings` | 0 occurrences of any `variants` entry, case-insensitive, in rendered text + HTML |
| `brand-title` | brand `name` appears in `document.title` |
| `console-errors` | 0 `pageerror` + 0 console errors of type `error` |
| `overflow-desktop` | `documentElement.scrollWidth - innerWidth === 0` at 1440×980 |
| `overflow-mobile` | same at 390×844 |
| `screenshots` | desktop and mobile PNGs written to the shots dir |
| `favicon` | favicon HTTP 200 and sha256 equals `brand.favicon`; `skip` when unset |

Full details, JSON shape, and CDP notes: see `references/verification.md`.

## MCP server

`relabeld mcp` speaks MCP over stdio and exposes exactly five tools: `relabel_scan`,
`relabel_init`, `relabel_apply`, `relabel_verify`, `relabel_report`. Nothing but protocol JSON is
written to stdout; diagnostics go to stderr. Tool arguments and a client config snippet:
`references/mcp.md`.

## Skills installer

```bash
relabeld skill install --agent claude     # ~/.claude/skills/relabel/SKILL.md
relabeld skill install --agent codex      # ~/.codex/skills/relabel/SKILL.md
relabeld skill install --agent dsh        # ~/.dsh-home/skills/relabel/SKILL.md
relabeld skill install --agent all
relabeld skill install --agent claude --prefix /tmp/skills   # custom root (tests/CI)
relabeld skill list                       # print the agent → root map
```

`--no-verify` skips the post-install frontmatter/reference check. Unknown agents exit `2`.

## Pitfalls

- **Favicon hashing:** the page's `<link rel="icon">` is followed; if the app serves a generated
  or cache-busted favicon, the hash will not match. Pin `brand.favicon` and serve it from the app.
- **`brand-strings` is case-insensitive and scans HTML too**, so old names inside inline scripts,
  JSON blobs, or `data-*` attributes fail the check even when invisible.
- **`--json` prints exactly one object.** Do not add progress logs to stdout in JSON mode; use
  the report or human mode for narration.
- **Overflow is strict.** A 1px `scrollWidth` excess fails. Fix wide fixed-width elements, not the
  check.
- **CDP mode reuses the attached browser's default context**; viewport pinning may be ignored on
  some builds — prefer launching a fresh headless browser when possible.
- **Trademark/license obligations survive rebranding.** Keep upstream license files and attribution
  (`keep`), and check the upstream trademark policy before serving third parties.

## Verification

Prove the toolchain itself before trusting a rebrand:

```bash
npm run build
node --test test/
node dist/cli.js verify --url http://127.0.0.1:8080/ --brand brand.yaml --json; echo "exit=$?"
node dist/cli.js report --input verify.json --out /tmp/relabel-report.html
grep -c 'https\?://' /tmp/relabel-report.html   # must be 0
```

Completion criteria: build clean, all tests pass, verify exits `0` with `summary.failed === 0`,
and the report has zero external references.

## References

- `references/verification.md` — check semantics, VerifyResult JSON, CDP, troubleshooting.
- `references/mcp.md` — MCP tools, argument mapping, client configuration.
- `references/brand-and-recipes.md` — `brand.yaml` fields, recipes, deploy, license rules.
