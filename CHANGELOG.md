# Changelog

All notable changes to `relabeld`. Built in versioned milestones.

## 1.0.3 — docs accuracy

- README docker badge no longer implies a published registry image; local Dockerfile build documented.

## 1.0.2 — docs and packaging polish

- README: npm package name, package URL, `npx relabeld` quick path, package contents, npm/license/node/docker badges.
- Repository default branch renamed to `main`; all absolute docs links now resolve.
- Version references in README/docs updated to 1.0.2 (no behaviour change).

## 1.0.1 — hardening

- `apply` ref guard now covers HTML/CSS/SVG asset references (`href`, `src`, `url()`), including
  root-absolute paths (suffix-matched against the repo) and `srcset`; inert references inside HTML
  and CSS comments are ignored. Unresolvable rewritten refs still refuse atomically; new
  `--allow-dangling` downgrades the refusal to a warning.
- `apply --json` on a refused write emits exactly `{ ok: false, error, danglingRefs[] }` and exits 1.
- `apply --json` `written` flags are byte-accurate: a no-op second run reports `written: false`.
- `verify` imports the canonical license-line rule from `scan`, so apply/scan/verify cannot drift
  (`(c)` requires a year; `license: Old Name` is not exempt).
- Recipes validate `renames[]` (array of `{from,to}`, non-empty, safe repo-relative paths).
- Packaging: source maps dropped from the tarball (27 files, 81.5 kB packed / 293.6 kB unpacked).
- GitHub Action: missing-proof branch now exits 1 instead of forwarding exit 0.

## 1.0.0 — initial public release

The complete white-label engine: deterministic CLI, proof-gated verification, recipes, and
first-class agent integration.

### CLI

- `scan` — detect brand surfaces (strings, assets, config, docs, CI) with classification and JSON output.
- `init` — generate `brand.yaml` from a scan + flags.
- `apply` — deterministic, idempotent patching: text strings (case-preserving, word-boundary),
  asset replacement, recipe-driven file renames, compose override; `--dry-run` writes nothing.
  Docker image references (`FROM`, `image:`) are never rewritten implicitly. Refuses to write
  (exit 1, atomic) when rewritten **relative** module/asset references would not resolve
  (root-absolute and `srcset` refs: resolved by suffix match, refusal when unresolved;
  `--allow-dangling` downgrades to a warning). Files that are
  binary, non-UTF-8, or over the read limit are reported as skipped, never partially patched;
  `--max-file-bytes` raises the limit.
- `verify` — headless proof with 7 checks: brand strings (attribution/`keep`-aware),
  page title, console errors (implicit `/favicon.ico` 404 ignored and counted),
  desktop overflow (1440×980), mobile overflow (390×844), screenshots, favicon hash
  (raw served HTML authoritative; http(s) and `data:` URIs). Exit 1 on failure;
  skipped checks are reported, exit 0 means "no failures".
- `report` — self-contained HTML report (inline CSS, base64 screenshots, light/dark).
- `recipe` — list / show / add; validated YAML recipes.
- `deploy` — render nginx vhost + optional Cloudflare DNS create + certbot command;
  exactly one explicit mode is required (`--dry-run` or `--apply`); certbot-managed TLS
  vhosts are preserved unless `--force`, every overwrite writes a timestamped backup.
- `doctor` — environment readiness check.
- `mcp` — MCP stdio server exposing `relabel_scan`, `relabel_init`, `relabel_apply`,
  `relabel_verify`, `relabel_report`.
- `skill` — install the agent skill for `claude` / `codex` / `dsh` / `all`.

### Recipes

- `uptime-kuma`, `brightbean` (BrightBean Studio → Nova Studio pattern).

### Integrations

- GitHub Action: verify gate with check-id `fail-on` handling and report artifact.
- Docker image: multi-stage build with Chromium for headless verification.
- CI (Node 20/22) and npm publish workflow (tag guard + provenance).
- Action pinned to `1.0.0` by default; `fail-on` accepts singular or plural check groups.

### Verified end-to-end

- Live demo: Uptime Kuma 1.23.17 white-labelled to **Nova Status** at `status.muneebs.space`,
  verify summary 7/7 checks pass, screenshots + HTML report committed under `demo/`.

## Milestones (build history)

| Version | Scope |
|---|---|
| 0.1.0 | repo scaffold, types/util/CLI router, docs skeleton |
| 0.2.0 | scan, init, apply, recipe engine, 2 recipes, doctor, tests |
| 0.3.0 | verify, report, MCP server, skill installer, deploy dry-run, Action, Docker, CI |
| 1.0.0 | apply renames + docker-ref protection, `data:` favicon handling, live demo, docs, public release |
