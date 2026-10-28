# Verification details

`relabeld verify` is the hard gate. It launches headless Chromium (playwright-core), loads the URL
twice — desktop 1440×980 and mobile 390×844 — and writes a `VerifyResult` JSON object.

## Invocation

```bash
relabeld verify --url <URL> --brand <brand.yaml> [--shots <dir>] [--cdp <ws-url>] [--out <file>] [--json]
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | required | page to verify |
| `--brand` | `brand.yaml` | brand spec; relative asset paths resolve against its directory |
| `--shots` | `.relabel/verify` | screenshot output directory (`desktop.png`, `mobile.png`) |
| `--cdp` | — | attach to a running Chromium via CDP instead of launching one |
| `--out` | — | also write the `VerifyResult` JSON to this path |
| `--json` | off | print exactly one JSON object to stdout |

Exit `0` = every check passed or skipped. Exit `1` = at least one `fail`. Exit `2` = usage or
unreadable brand spec.

## Browser resolution

Order: `opts.executablePath` (internal/tests), `$RELABEL_CHROME`, `/usr/bin/chromium-browser`,
`/usr/bin/google-chrome`. The first binary that launches headless wins; a broken shim (for example
a snap wrapper that dies at startup) falls through to the next candidate. With `--cdp` the tool
calls `chromium.connectOverCDP` and reuses the browser's default context.

## Checks

| id | status | detail on fail |
|---|---|---|
| `brand-strings` | `pass` when every `variants` entry has 0 matches. Case-insensitive count over `document.body.innerText` plus `document.documentElement.outerHTML` in both viewports. | per-variant counts, e.g. `"Uptime Kuma" ×2` |
| `brand-title` | `pass` when every probed `document.title` contains `brand.name` (case-insensitive). | the titles found |
| `console-errors` | `pass` when 0 pageerror + 0 console errors of type `error` across both loads. | first three messages |
| `overflow-desktop` | `pass` when `scrollWidth - innerWidth === 0` at 1440×980. | the measured difference |
| `overflow-mobile` | same at 390×844. | the measured difference |
| `screenshots` | `pass` when both PNGs exist and are non-empty. | missing/empty file names |
| `favicon` | `skip` when `brand.favicon` is unset. Otherwise `pass` when the page's icon URL answers HTTP 200 and its sha256 equals the brand asset's sha256. | HTTP status, mismatch hashes, fetch error |

If the page fails to navigate, brand checks fail (absence cannot be proven) and both overflow
checks fail with the navigation error. If no browser can be launched, every check fails with the
launch error in the detail.

## VerifyResult JSON

```json
{
  "url": "https://status.example.com/",
  "brandName": "Nova Status",
  "checks": [
    { "id": "brand-strings", "title": "old brand strings absent", "status": "pass", "detail": "..." }
  ],
  "screenshots": [
    { "name": "desktop", "path": "/abs/path/desktop.png" },
    { "name": "mobile",  "path": "/abs/path/mobile.png" }
  ],
  "summary": { "passed": 6, "failed": 0, "skipped": 1 },
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

Statuses are exactly `pass`, `fail`, `skip`. The seven ids above are stable; automation should key
on ids, not titles.

## Report

```bash
relabeld report --input verify.json --out report.html
```

The report embeds CSS and screenshots (base64 `data:` URIs) and contains no external references —
safe to attach to a ticket or email. It renders light/dark via `prefers-color-scheme`, uses
hairline borders and tabular numbers, and never fetches anything.

## Troubleshooting

- **`could not launch headless Chromium`** — install Chrome/Chromium or point `RELABEL_CHROME` at a
  working binary. On a snap-based host, `/usr/bin/chromium-browser` may be an unusable shim; the
  fallback to `/usr/bin/google-chrome` handles it.
- **Console errors from third-party analytics** — they are real console errors; remove the script
  or accept a failed gate. Do not silence the listener.
- **Overflow only on mobile** — look for fixed widths, `min-width` tables, and wide images; the
  check measures the document, not a container.
- **Favicon mismatch** — the app is serving a cached or generated icon. Replace the served asset
  and redeploy, then re-run verify.
- **Screenshots show a blank page** — the app needs more time; check that the URL is reachable from
  the verifying host (not just your laptop) and that no auth wall intercepts the load.
