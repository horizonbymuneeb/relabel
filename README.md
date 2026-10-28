# relabeld

**White-label any self-hosted app with one command — deterministic, verified, agent-agnostic.**

Your self-hosted apps still wear someone else's name. `relabeld` scans an app for every brand
surface (strings, logos, favicons, env defaults, page titles), applies your brand from a single
`brand.yaml`, and then **proves it with a headless browser**: zero old-brand strings in the
rendered page, zero console errors, zero layout overflow on desktop and mobile, screenshots saved.

No AI in the loop. No tokens spent. Same output every run.

```bash
npx relabeld scan ./uptime-kuma            # what would change (read-only)
npx relabeld init --name "Nova Status" --domain status.example.com
npx relabeld apply                          # patch strings, assets, compose
npx relabeld verify --url https://status.example.com   # proof + screenshots
```

## Why

Rebranding a self-hosted app is a manual afternoon that always leaves residue: an upstream logo in
`.github/assets/`, a stray product name in CI configs, a favicon nobody replaced. Agents can do it
once, but they cannot prove it — and every run is different.

`relabeld` makes the rebrand a **repeatable build step**: recipes encode per-app knowledge,
verification is a hard gate, and it runs anywhere (CI, Docker, cron, MCP, any agent).

## Commands

| Command | What it does |
|---|---|
| `scan` | detect brand surfaces and assets (read-only, JSON output) |
| `init` | write `brand.yaml` (name, domain, palette, logo, favicon, email sender) |
| `apply` | patch text/assets/env/compose; `--dry-run` supported |
| `verify` | headless proof: brand strings, console errors, overflow, screenshots |
| `report` | self-contained HTML report from a verify result |
| `recipe` | list / show / add per-app recipes |
| `deploy` | render nginx vhost + optional Cloudflare DNS + certbot (`--dry-run` default) |
| `doctor` | check the local environment |
| `mcp` | MCP stdio server (5 tools) |
| `skill` | install the agent skill for claude / codex / dsh |

## Verification matrix (what "done" means)

| Check | Pass condition |
|---|---|
| `brand-strings` | 0 old brand variants in rendered DOM + HTML |
| `brand-title` | new brand name present in `<title>` |
| `console-errors` | 0 page errors / console errors |
| `overflow-desktop` | `scrollWidth - innerWidth === 0` at 1440×980 |
| `overflow-mobile` | same at 390×844 |
| `screenshots` | desktop + mobile saved |
| `favicon` | 200 + sha256 matches your brand asset |

## Agent integrations

- **MCP:** `relabeld mcp` exposes `relabel_scan`, `relabel_init`, `relabel_apply`, `relabel_verify`, `relabel_report`.
- **Skill:** `relabeld skill install --agent claude|codex|dsh|all`
- **CI:** composite GitHub Action runs the verify gate on every PR.
- Works with any harness because the core is a plain CLI.

## Recipes

Recipes encode per-app knowledge (upstream strings, asset targets, compose service/port, env vars):

```bash
relabeld recipe list
relabeld recipe show uptime-kuma
relabeld recipe add ./my-app-recipe
```

Ship a recipe for your favorite app — one YAML file, PRs welcome.

## License compliance

`relabeld` never removes upstream license, copyright, or attribution text. White-labelling does not
change your obligations: keep the upstream license, publish modifications if the license requires it,
and only rebrand software you are allowed to rebrand. Check the upstream project's trademark policy
before offering a rebranded instance to third parties.

## Status

Early. See `docs/` for usage, recipe spec, and verification details.

MIT © Muneeb Anjum
