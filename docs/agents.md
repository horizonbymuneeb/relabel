# Agents and CI

`relabeld` is agent-agnostic: one deterministic CLI, JSON output, stable exit codes. There are three
supported integration surfaces — an MCP stdio server, an installable skill, and a CI gate (direct
CLI or the repository's composite action).

## Exit codes and JSON contracts

| Contract | Detail |
|---|---|
| `--json` | Exactly one JSON object on stdout. Diagnostics go to stderr. |
| exit `0` | Success; for `verify`, no failures (skipped checks are reported in the result, so read `--json` to see them). |
| exit `1` | A check or step failed. `verify` still writes the JSON, report inputs, and screenshots. |
| exit `2` | Usage error: missing/unknown flag, missing required argument, missing `deploy` mode. |

`VerifyResult` is the proof object: `url`, `brandName`, `checks[]` (`id`, `title`, `status`
`pass|fail|skip`, `detail`), `screenshots[]`, `summary` (`passed`, `failed`, `skipped`),
`generatedAt`. Gate on `summary.failed === 0`.

`scan --json` returns `ScanResult`: `root`, `scannedFiles`, `brandTokens`, `findings[]`, `assets[]`,
`summaries`, `skipped[]` (files over the read limit), `maxFileBytes`, `generatedAt`.

`apply --json` returns `{ dryRun, brand, recipe, changed[], skipped[], renames[], assets[], compose, warnings[], totals }`; on a refused write it returns exactly `{ ok: false, error, danglingRefs: [{file,specifier,kind}] }` and exits 1.

## MCP server

```bash
relabeld mcp
```

A stdio MCP server. It writes nothing but JSON-RPC to stdout; all diagnostics go to stderr, so it is
safe to embed. It exposes exactly five tools and shuts down on stdin EOF.

Client configuration (Claude Code, Codex, DSH, or any MCP client):

```json
{
  "mcpServers": {
    "relabel": {
      "command": "npx",
      "args": ["relabeld", "mcp"]
    }
  }
}
```

Or with a global install: `"command": "relabeld"`, `"args": ["mcp"]`. Requires Node.js >= 20;
`relabel_verify` also needs headless Chromium, exactly like the CLI.

### Tools

| Tool | Arguments | Result |
|---|---|---|
| `relabel_scan` | `root?` (default `.`), `cwd?` | `ScanResult` JSON. Read-only. |
| `relabel_init` | `name` (required), `domain?`, `from?`, `force?`, `cwd?` | `{ path, brand }` for the written `brand.yaml`. `from` is the source directory (same as the CLI positional). Refuses to overwrite without `force`. |
| `relabel_apply` | `dryRun?`, `cwd?` | `{ changed, skipped, renames, ... }` plan or the applied result. `dryRun` writes nothing. A recipe is auto-detected from the app (there is no MCP argument for it in v1.0.2). |
| `relabel_verify` | `url` (required), `brand?`, `shots?`, `cdp?`, `cwd?` | `VerifyResult` JSON. A run with `summary.failed > 0` comes back as an MCP error result (`isError: true`) with the CLI output attached, so the client cannot mistake a failed gate for success. |
| `relabel_report` | `input`, `out` (both required), `cwd?` | `{ out, bytes, images, summary, generatedAt }`. |

Notes:

- Tool calls spawn the same `relabeld` CLI with `--json`, so MCP results match CLI output.
- Non-zero CLI exits become MCP tool errors with stderr attached; missing required arguments fail
  fast with a text error, never a crash.
- `cwd` is resolved against the server's working directory; `root`/`brand`/`shots`/`input`/`out`
  are resolved against that `cwd`.
- `relabel_apply` and `relabel_verify` operate on a directory that already has a `brand.yaml`
  (create it with `relabel_init` or `relabeld init` first).

### Example session

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"relabel_scan","arguments":{"root":"./app"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"relabel_verify","arguments":{"url":"https://status.example.com","brand":"brand.yaml"}}}
```

## Skill install

```bash
relabeld skill install --agent claude|codex|dsh|all [--prefix <dir>] [--no-verify] [--json]
relabeld skill list [--json]
```

The bundled skill is `skills/relabel/`: `SKILL.md` plus `references/brand-and-recipes.md`,
`references/mcp.md`, and `references/verification.md`.

| Agent | Default skill root |
|---|---|
| `claude` | `~/.claude/skills` |
| `codex` | `~/.codex/skills` |
| `dsh` | `~/.dsh-home/skills` |

The installer copies the skill into `<root>/relabel/` and then verifies the install: `SKILL.md`
exists, its frontmatter has a non-empty `name` and `description`, the body documents the `relabeld`
CLI, and at least one reference markdown file is present. A failed verification makes the command
exit `1`.

- `--agent all` installs into all three roots (with `--prefix`, it copies once and reports each
  agent).
- `--prefix <dir>` installs into `<dir>/relabel` instead of an agent root — useful for
  project-local skill directories.
- `--no-verify` skips the post-install validation.
- `--json` prints `{ installed[], verified, verification[], version }`.
- `skill list` (or `--list`) prints the agent-to-root map and the bundled skill source path.

Typical human output:

```
relabeld skill install 1.0.0
  claude  /home/me/.claude/skills/relabel
    references/brand-and-recipes.md (3093 bytes)
    references/mcp.md (2464 bytes)
    references/verification.md (4403 bytes)
    SKILL.md (7371 bytes)
  verify  ok (1 install, frontmatter valid, references present)
```

## CI gate

The gate is the CLI itself: `verify` exits non-zero when any check fails, so it drops into any CI as
one step.

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npm install -g relabeld
- run: relabeld verify --url "$APP_URL" --brand brand.yaml --json --out verify.json
- run: relabeld report --input verify.json --out report.html
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: relabel-report
    path: |
      verify.json
      report.html
      .relabel/verify/desktop.png
      .relabel/verify/mobile.png
```

The app must already be deployed at `$APP_URL`; this is a verification gate, not a build step.

### Composite action

The repository ships `action.yml` as a composite action. It uses `npx relabeld@<version>` for each
step, so it always runs the published CLI rather than building this checkout.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `url` | yes | — | URL of the running app to verify. |
| `brand` | no | `brand.yaml` | Path to the brand spec, relative to the repository root. |
| `version` | no | `1.0.0` | Pinned relabeld npm version to run. Bump it deliberately instead of tracking `latest` in a release gate. |
| `cdp` | no | — | Chrome DevTools endpoint to reuse instead of launching Chromium. |
| `report` | no | — | Output path for the self-contained HTML report; uploaded as the `relabel-report` artifact. |
| `fail-on` | no | `brand,console,overflow` | Comma-separated check groups that fail the gate. Singular and plural are normalized, so `screenshot` and `screenshots` both match. A group matches a failed check id exactly, as a prefix (`overflow` matches `overflow-desktop`), or by the id's first segment. Groups in the check set: `brand`, `console`, `overflow`, `screenshots`, `favicon`. |

What the action does:

1. Runs `verify --json --out <runner-temp>/relabel-verify.json` (plus `--cdp` when set). The JSON proof
   is always produced, even on a failing run.
2. Applies the `fail-on` policy from that JSON: a failed check fails the gate only if it matches a
   configured group (a group matches by check id, id prefix, or the id's first segment, so `brand`
   covers `brand-strings` and `brand-title`; `screenshot`/`screenshots` both match `screenshots`).
   Failures outside the policy are reported as a warning and the gate passes.
3. When `report` is set, runs `report --input <json> --out <report>` and uploads the HTML file as the
   `relabel-report` artifact (14-day retention).

```yaml
- uses: horizonbymuneeb/relabel@v1
  with:
    url: https://status.example.com
    brand: brand.yaml
    report: report.html
```

`report` is exposed as an action output as well. The app must already be deployed at `url`; the
action is a gate, not a build step. For a fully offline gate, run the CLI directly as shown above and
skip the `version`/`npx` indirection.

## Doctor check

Before a run, an agent can call the environment check directly:

```bash
relabeld doctor          # human table, exit 1 when a required check fails
relabeld doctor --json   # { checks: [{ name, ok, required, detail }], ok }
```

Required checks are node >= 20 and a working chromium/chrome binary (the browser line shows the path
and version it executed). docker, nginx, certbot, and a Cloudflare token are warnings because they
only matter for running the app or for `deploy`.


## Recommended agent loop

0. `relabeld doctor --json` (or the same checks via shell) before the first run: node >= 20 and a
   chromium binary are required for verification.
1. `relabel_scan` on the app directory; read `brandTokens`, `findings`, `assets`.
2. `relabel_init` with the target brand (or `relabeld init` if you need palette/asset flags).
3. `relabel_apply` with `dryRun: true`; review `changed`/`skipped`; then apply.
4. Deploy/serve the app (outside `relabeld` unless you use `deploy`).
5. `relabel_verify`; gate on `summary.failed === 0`; keep `verify.json` and screenshots.
6. `relabel_report` when a human needs the evidence in one file.

Two rules keep agent runs honest: never treat `scan` as proof (it is detection, not verification),
and never pass `verify` until the rebuilt app is the one being served.
