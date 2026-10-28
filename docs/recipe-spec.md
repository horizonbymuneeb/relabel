# Recipe spec (v0.1)

A recipe is one directory under `recipes/<id>/` containing `recipe.yaml`. It records the per-app
knowledge a deterministic white-label needs: which strings identify the upstream app, which asset
targets to replace, env defaults, compose service/port, and verification defaults.

In v0.1.0 a recipe is **data**. The `recipe` command validates, lists, shows and installs recipes;
`scan`, `apply`, `deploy`, and `verify` do not read recipes yet. The spec the other commands consume
is `brand.yaml`, and `init` seeds it from the scan. Recipe-driven defaults are planned for v0.2.

```yaml
id: uptime-kuma
name: Uptime Kuma
upstream: https://github.com/louislam/uptime-kuma
docs: https://github.com/louislam/uptime-kuma/wiki

# Substrings that identify the upstream app inside a repo/app tree.
match:
  - uptime-kuma
  - Uptime Kuma

# Brand strings that must be replaced (case-preserved by the patcher).
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

# Optional: environment defaults the app reads at runtime.
env:
  - name: APP_NAME
    from: UPTIME_KUMA_TITLE
    value: "Uptime Kuma"

# Optional: explicit file rules for cases where a plain string rewrite is wrong.
files:
  - path: docker-compose.yml
    replace:
      - { from: "container_name: uptime-kuma", to: "container_name: nova-status" }

# Optional: how the app is run, used by deploy/verify defaults.
compose:
  service: uptime-kuma
  port: 3001
  base: https://github.com/louislam/uptime-kuma

# Optional: verification defaults.
verify:
  url: https://status.example.com
  paths: ["/"]
```

## Rules

- Every key above is structurally validated when a recipe is loaded by `recipe list`, `recipe show`,
  or `recipe add`: required fields must be present and typed (`id` kebab-case, `upstream` an http(s)
  URL, `match`/`strings` string arrays, asset `kind` one of `logo|favicon|og-image`, ...). Unknown
  top-level keys are tolerated in v0.1.0; there is no standalone `validate` subcommand.
- The recipe library root is `recipes/` next to the installed package. `RELABELD_RECIPES_DIR`
  overrides it.
- `strings` record the upstream spellings. The replacement engine that runs today takes its variants
  from `brand.yaml` (`init` writes the scan's `brandTokens` into `variants`); recipe `strings` are not
  consumed yet.
- Replacement in `apply` is word-boundary and case-preserving: `Uptime Kuma` → `Nova Status`,
  `uptime-kuma` → `nova-status`, `UPTIME KUMA` → `NOVA STATUS`.
- `brand.yaml` `keep` entries protect files and lines from rewriting. They are substring matches, not
  globs: a path hit skips the file (case-insensitive), a literal line hit leaves that line untouched.
- `env` is validated and recorded. In v0.1.0 `apply` writes only `APP_NAME: <brand.name>` from
  `brand.yaml` into the generated `docker-compose.relabel.yml`; recipe `env`, `files`, `compose`, and
  `verify` keys are not used by the other commands yet.
- Recipes are data only: no executable hooks. Hooks are planned for v0.2 under an explicit `hooks:`
  key so a pulled recipe cannot smuggle code into the CLI.

## Contributing a recipe

1. Model the new recipe on `recipes/uptime-kuma/recipe.yaml` (or `recipes/brightbean/recipe.yaml` for
   a second data point).
2. Fill `match`, `strings`, `assets`, and `compose`; keep the upstream license and notice paths out of
   anything that gets rewritten.
3. Validate it with `relabeld recipe show <id>` and check the library health with
   `relabeld recipe list` (the list command reports every invalid recipe instead of hiding it).
4. Cross-check the recorded strings and asset targets against `relabeld scan <app> --json`; add a
   target if the scan finds an asset the recipe missed.
5. Add a fixture-based test under `test/recipes.test.ts` and open a PR.
