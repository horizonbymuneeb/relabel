# Changelog

All notable changes to `relabeld`. Built in versioned milestones.

## 1.0.0 — initial public release

The complete white-label engine: deterministic CLI, proof-gated verification, recipes, and
first-class agent integration.

### CLI

- `scan` — detect brand surfaces (strings, assets, config, docs, CI) with classification and JSON output.
- `init` — generate `brand.yaml` from a scan + flags.
- `apply` — deterministic, idempotent patching: text strings (case-preserving, word-boundary),
  asset replacement, recipe-driven file renames, compose override; `--dry-run` writes nothing.
  Docker image references (`FROM`, `image:`) are never rewritten implicitly.
- `verify` — headless proof with 7 checks: brand strings, page title, console errors,
  desktop overflow (1440×980), mobile overflow (390×844), screenshots, favicon hash
  (http(s) and `data:` URIs). Exit 1 on failure.
- `report` — self-contained HTML report (inline CSS, base64 screenshots, light/dark).
- `recipe` — list / show / add; validated YAML recipes.
- `deploy` — render nginx vhost + optional Cloudflare DNS create + certbot command;
  `--dry-run` default, `--apply` opt-in, idempotent.
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
