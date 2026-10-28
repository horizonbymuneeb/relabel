# MCP server

`relabeld mcp` runs an MCP server over stdio. It exposes exactly five tools and writes nothing but
JSON-RPC protocol messages to stdout — all diagnostics go to stderr, so it is safe to embed.

## Client configuration

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

Or, with a global install: `"command": "relabeld", "args": ["mcp"]`.

Requirements: Node.js >= 20 and `@modelcontextprotocol/sdk` (a normal dependency of `relabeld`).
`relabel_verify` additionally needs a headless Chromium, exactly like the CLI.

## Tools

### relabel_scan

Scan a repo for brand surfaces without modifying it.

```json
{ "root": "./app", "cwd": "/work/project" }
```

Both fields optional; `root` defaults to `.`, `cwd` defaults to the server's working directory.
Returns `ScanResult` JSON (`scannedFiles`, `brandTokens`, `findings`, `assets`, `summaries`).

### relabel_init

Create `brand.yaml` from the given branding.

```json
{ "name": "Nova Status", "domain": "status.example.com", "from": "./app", "force": false }
```

`name` is required. `force` overwrites an existing `brand.yaml`.

### relabel_apply

Apply `brand.yaml` to the app.

```json
{ "dryRun": true, "cwd": "/work/project" }
```

`dryRun` reports changes without writing. Without it, strings/assets/env/compose are patched.

### relabel_verify

Run the headless proof and return `VerifyResult` JSON.

```json
{
  "url": "https://status.example.com/",
  "brand": "brand.yaml",
  "shots": ".relabel/verify",
  "cdp": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

`url` is required. Optional `brand`/`shots`/`cdp`/`cwd`. The tool result is the JSON object; check
`summary.failed === 0` (an exit-1 run is returned as an MCP error result, so the client sees the
failure).

### relabel_report

Render a self-contained HTML report from a verification result.

```json
{ "input": "verify.json", "out": "report.html" }
```

Both required. Returns a JSON summary (`out`, `bytes`, `images`, `summary`).

## Behaviour notes

- Tool calls are executed by spawning the same `relabeld` CLI with `--json`, so MCP results match
  the CLI byte-for-byte.
- Non-zero CLI exits become MCP tool errors (`isError: true`) with the CLI stderr attached.
- Unknown tool names and missing required arguments fail fast with a text error, never a crash.
- Initialize, `tools/list`, and `tools/call` are all handled; the tool list is fixed at five.
