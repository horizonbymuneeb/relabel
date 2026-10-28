# Recipe spec (v0.1)

A recipe is one directory under `recipes/<id>/` containing `recipe.yaml`. It encodes the
per-app knowledge `relabeld` needs to white-label an app deterministically.

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

- `strings` are matched with word boundaries and case-preserved: `Uptime Kuma` → `Nova Status`,
  `uptime-kuma` → `nova-status`, `UPTIME KUMA` → `NOVA STATUS`.
- Lines matching `keep` globs (license headers, copyright, NOTICE, SPDX) are never rewritten.
- `env` values are written into the generated `docker-compose.relabel.yml` override.
- Unknown keys are rejected by `recipe validate` (run implicitly on `recipe show`/`apply`).
- Recipes are data only: no executable hooks in v0.1. Hooks land in v0.2 under an explicit
  `hooks:` key so containers cannot smuggle code into the CLI.

## Contributing a recipe

1. Copy `recipes/_template/recipe.yaml`.
2. Fill `match`, `strings`, `assets`, `compose`.
3. Run `relabeld scan <path-to-app> --json` and confirm no finding is missing.
4. Run `relabeld apply <path> --brand brand.yaml --dry-run` and confirm the plan is complete.
5. Add a test under `test/recipes.test.ts` (fixture-based) and open a PR.
