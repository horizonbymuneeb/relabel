# Verification

`relabeld verify` answers one question with evidence: **is this app actually wearing my brand?**

It opens the app in headless Chromium at two viewports, runs seven checks, saves screenshots, and
exits non-zero if anything fails. The result is a `VerifyResult` JSON object, rendered to a
self-contained HTML report by `relabeld report`.

## Checks

| id | What it proves |
|---|---|
| `brand-strings` | No upstream brand variant appears in the rendered DOM text or page HTML (case-insensitive, variants taken from `brand.yaml`). |
| `brand-title` | The new brand name appears in `document.title`. |
| `console-errors` | No `pageerror` and no `console` message of type `error`. Third-party beacons are still counted; fix them or allowlist in a future version. |
| `overflow-desktop` | `document.documentElement.scrollWidth - window.innerWidth === 0` at 1440×980. |
| `overflow-mobile` | Same assertion at 390×844 (drawer/scroll layout must not overflow). |
| `screenshots` | Desktop and mobile screenshots written to `--shots`. |
| `favicon` | The favicon responds 200 and its sha256 matches the brand asset referenced by the recipe (skipped when no brand favicon is configured). |

## Exit codes

- `0` — every check passed
- `1` — at least one check failed (report + screenshots still written)
- `2` — usage error (missing `--url` or unreadable `brand.yaml`)

## CI usage

```yaml
- uses: horizonbymuneeb/relabel@v1
  with:
    url: https://status.example.com
    brand: brand.yaml
```

or directly:

```bash
npx relabeld verify --url "$URL" --brand brand.yaml --json > verify.json
npx relabeld report --input verify.json --out report.html
```

## Notes

- Verification runs against the **served app**, not the source tree. Rebuild/redeploy first.
- Boxes without a bundled browser can point at a Chrome DevTools endpoint: `--cdp http://127.0.0.1:9223`.
- Screenshots are PNG, full page, device scale 1, deterministic dimensions.
