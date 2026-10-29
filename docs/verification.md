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
| `console-errors` | No `pageerror` and no `console` message of type `error`. Chromium's implicit `/favicon.ico` 404 message is ignored (and counted in the detail: `0 page errors, 0 console errors (ignored 1 implicit /favicon.ico 404)`); any other resource-load error still fails. Third-party beacons are still counted. |
| `overflow-desktop` | `document.documentElement.scrollWidth - window.innerWidth <= 0` at 1440×980 (only positive overflow fails; negative is normal with classic scrollbars). |
| `overflow-mobile` | Same assertion at 390×844 (drawer/scroll layout must not overflow). |
| `screenshots` | Desktop and mobile screenshots written to `--shots`. |
| `favicon` | The served HTML `<link rel="icon">` is authoritative (the runtime DOM href is only a fallback, then `/favicon.ico`). `pass`: http(s) icon returns 200 and its sha256 matches a configured brand asset (`brand.favicon` or `brand.logo`), or a `data:` icon decodes to matching bytes. `fail`: http(s) 404, http(s) fetch error, or 200 with a sha256 that matches no configured brand asset. `skip`: no `brand.favicon`/`brand.logo` configured, a `data:` icon that decodes but differs, an undecodable `data:` icon, or a `blob:`/`about:`/other scheme. |

## Exit codes

- `0` — no check failed (passes and skips; a skipped check does not fail the gate)
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
- Boxes without a bundled browser can point at a Chrome DevTools endpoint: `--cdp http://127.0.0.1:9223`, or
  pass `--executable /path/to/chrome` to launch a specific binary.
- Screenshots are PNG viewport captures at device scale 1: `desktop.png` at 1440x980 and
  `mobile.png` at 390x844. They are not full-page captures.
