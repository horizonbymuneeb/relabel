# brand.yaml, recipes, deploy, and licensing

## brand.yaml

`init` writes it; you can also edit it by hand (`scan` tells you which strings to list).

```yaml
name: Nova Status                 # new brand name — must appear in <title>
domain: status.example.com
palette:
  primary: "#1f6feb"
  accent: "#2da44e"               # optional
  background: "#ffffff"           # optional
logo: assets/nova-logo.svg        # optional, relative to brand.yaml
favicon: assets/nova-favicon.png  # optional; when set, verify hashes it
emailFrom: Nova Status <hello@example.com>
variants:                         # old brand strings to eliminate (case-insensitive)
  - Uptime Kuma
  - UptimeKuma
  - uptime-kuma
keep:                             # strings that must NOT be replaced
  - Uptime Kuma is licensed under MIT
```

Rules of thumb:

- Put every upstream spelling in `variants`; verify fails on any left in rendered text or HTML.
- Never put license/copyright/attribution text in `variants`. Put it in `keep`.
- Asset paths are resolved against the directory containing `brand.yaml`.
- `favicon` enables the favicon hash check; leave it unset to get `skip` instead.

## Recipes

Recipes encode per-app knowledge (upstream strings, asset targets, compose service/port, env vars)
so a rebrand is repeatable across installs.

```bash
relabeld recipe list
relabeld recipe show uptime-kuma
relabeld recipe add ./my-app-recipe
```

A recipe YAML has `id`, `name`, `upstream`, optional `docs`, `match`, `strings`, `assets`, `env`,
`files`, `compose` (service/port/base), `verify` (url/paths), and `notes`. Use `apply` to consume it;
`init` can seed `brand.yaml` from a matched recipe.

Writing a recipe for a new app: list the upstream brand strings it must remove, the asset targets it
serves (logo, favicon, og-image), the compose service/port used for local verification, and any env
vars that carry the app name. Keep `strings` limited to actual brand text — never license text.

## Deploy

`relabeld deploy` renders an nginx vhost and (opt-in) configures Cloudflare DNS and a TLS cert.

```bash
relabeld deploy --dry-run     # default posture: print the plan, touch nothing
relabeld deploy               # requires explicit flags/credentials
```

Provider credentials come from environment variables; never commit them to `brand.yaml` or a recipe.
Deploy only after `verify` exits `0` against the deployed URL.

## Licensing and trademarks

Rebranding is a legal act, not just a find-and-replace:

- Keep upstream `LICENSE`, `NOTICE`, copyright headers, and attribution text. `relabeld` does not
  remove them, and `keep` protects them from string replacement.
- Copyleft licenses may require publishing modifications and retaining notices; check the app's
  license before redistributing.
- Trademarks are separate from copyright. Check the upstream trademark policy before offering a
  rebranded instance to third parties; renaming does not grant trademark rights.
- Only rebrand software you are allowed to rebrand. When in doubt, read the LICENSE and the project's
  brand/trademark policy.
