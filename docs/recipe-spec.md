# Recipe spec (v1.0)

A recipe is one directory under `recipes/<id>/` containing `recipe.yaml`. It records the per-app
knowledge a deterministic white-label needs: which strings identify the upstream app, which asset
targets to replace, file renames that keep rewritten references resolving, env defaults, compose
service/port, and verification defaults.

What consumes a recipe in v1.0.2:

- `apply` reads `renames` (file renames after the text patch) and the `files:` rule paths (an opt-in
  that allows rewriting docker image references of those files). It auto-detects the recipe from the
  app's `package.json` name or directory name, or takes `--recipe <id|path>`.
- `recipe list`, `recipe show`, and `recipe add` load and structurally validate every recipe.
- `scan`, `init`, `verify`, and `deploy` do not read recipes. The variant knowledge those commands use
  lives in `brand.yaml`, which `init` seeds from the scan.

Everything else in a recipe (`strings`, `assets`, `env`, `compose`, `verify`, `notes`) is recorded,
validated, and shown by `recipe show`; other commands do not consume it yet.

```yaml
id: uptime-kuma
name: Uptime Kuma
upstream: https://github.com/louislam/uptime-kuma
docs: https://github.com/louislam/uptime-kuma/wiki

# Substrings that identify the upstream app inside a repo/app tree.
match:
  - package.json
  - README.md
  - docker-compose.yml
  - src/
  - server/
  - public/

# Brand strings the upstream app uses (recorded; the patcher takes variants from brand.yaml).
strings:
  - Uptime Kuma
  - uptime-kuma
  - Uptime-Kuma

# Assets to replace, with the paths they normally live at in the upstream repo.
assets:
  - kind: logo
    targets: ["public/icon.svg"]
  - kind: favicon
    targets: ["public/favicon.ico"]

# File renames applied after the text patch, so rewritten imports resolve.
# `{{slug}}`, `{{kebab}}`, `{{snake}}`, `{{pascal}}`, `{{camel}}`, `{{name}}`, `{{lower}}` are
# rendered from brand.name.
renames:
  - from: server/uptime-kuma-server.js
    to: server/{{slug}}-server.js

# Optional: environment defaults the app reads at runtime (recorded, not yet consumed).
env:
  - name: APP_NAME
    from: UPTIME_KUMA_TITLE
    value: "Uptime Kuma"

# Optional: explicit file rules. The paths act as an opt-in for docker image ref rewriting;
# the `replace` list is recorded for a future release.
files:
  - path: docker/docker-compose.yml
    replace:
      - { from: "container_name: uptime-kuma", to: "container_name: nova-status" }

# Optional: how the app is run (recorded, not yet consumed by deploy/verify).
compose:
  service: uptime-kuma
  port: 3001
  base: docker-compose.yml

# Optional: verification defaults (recorded; verify still takes --url explicitly).
verify:
  url: http://localhost:3001
  paths: ["/", "/dashboard"]

notes:
  - LICENSE (MIT) must stay untouched; keep upstream copyright lines even after rebranding.
```

## Rules

- Every recipe loaded by `recipe list`, `recipe show`, or `recipe add` is validated: required fields
  (`id`, `name`, `upstream`, `match`, `strings`, `assets`) must be present and typed, `id` is
  kebab-case, `upstream` an http(s) URL, `assets[].kind` one of `logo|favicon|og-image`, and
  `renames[]` entries need non-empty `from`/`to`. Unknown top-level keys are tolerated in v1.0.2;
  there is no standalone `validate` subcommand.
- The recipe library root is `recipes/` next to the installed package. `RELABELD_RECIPES_DIR`
  overrides it.
- `renames` are applied after the text patch, in order, and are idempotent: a file already at the
  target path is reported as done, never renamed twice. Paths must stay inside the repo.
- Each rename target is rendered from `brand.yaml` (`{{slug}}`, `{{pascal}}`, ...), so the same recipe
  works for any brand.
- Replacement in `apply` is word-boundary and case-preserving: `Uptime Kuma` → `Nova Status`,
  `uptime-kuma` → `nova-status`, `UPTIME KUMA` → `NOVA STATUS`.
- `brand.yaml` `keep` entries protect files and lines from rewriting. They are substring matches, not
  globs: a path hit skips the file (case-insensitive), a literal line hit leaves that line untouched.
- Docker image references (`FROM ...`, `image: ...`) are never rewritten implicitly. They are only
  rewritten inside a file listed in the recipe's `files:` rules.
- `env` is validated and recorded. `apply` writes only `APP_NAME: <brand.name>` from `brand.yaml` into
  the generated `docker-compose.relabel.yml`; recipe `env`, `compose`, and `verify` keys are not used
  by other commands in v1.0.2.
- Recipes are data only: no executable hooks. A `hooks:` key is intentionally absent and unimplemented,
  so a pulled recipe cannot smuggle code into the CLI.

## Contributing a recipe

1. Model the new recipe on `recipes/uptime-kuma/recipe.yaml` or `recipes/brightbean/recipe.yaml`.
2. Fill `match`, `strings`, `assets`, `renames`, and `compose`; keep the upstream license and notice
   paths out of anything that gets rewritten.
3. Validate with `relabeld recipe show <id>` and check library health with `relabeld recipe list`
   (the list command reports every invalid recipe instead of hiding it).
4. Cross-check the recorded strings and asset targets against `relabeld scan <app> --json`; add a
   target if the scan finds an asset the recipe missed.
5. Add a fixture-based test under `test/recipes.test.ts` and open a PR.
