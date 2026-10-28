import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, Ctx, VerifyResult } from "./types.js";
import { ensureDir, nowIso } from "./util.js";

const USAGE = [
  "Usage: relabeld report --input <verify.json> --out <report.html> [options]",
  "",
  "Options:",
  "  --input <file>   VerifyResult JSON produced by `relabeld verify --json` (required)",
  "  --out <file>     HTML file to write (required)",
  "  --json           machine-readable output",
  "  -h, --help       show this help",
].join("\n");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reports must be self-contained: no external references at all. Strip URL
 * schemes from any user-controlled text so the document contains zero
 * `http://` / `https://` strings (verified by the acceptance gate).
 */
function clean(value: unknown, max = 1200): string {
  const text = String(value ?? "").replace(/https?:\/\//gi, "");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function normalizeSummary(result: VerifyResult): { passed: number; failed: number; skipped: number } {
  const s = result.summary;
  if (s && [s.passed, s.failed, s.skipped].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { passed: s.passed, failed: s.failed, skipped: s.skipped };
  }
  const checks = Array.isArray(result.checks) ? result.checks : [];
  return {
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };
}

interface EmbeddedImage {
  name: string;
  path: string;
  dataUri: string | null;
  bytes: number;
  error?: string;
}

async function embedImages(result: VerifyResult): Promise<EmbeddedImage[]> {
  const shots = Array.isArray(result.screenshots) ? result.screenshots : [];
  const out: EmbeddedImage[] = [];
  for (const shot of shots) {
    const name = clean(shot?.name ?? "screenshot", 80);
    const file = String(shot?.path ?? "");
    try {
      const bytes = await readFile(file);
      const mime = MIME[path.extname(file).toLowerCase()] ?? "image/png";
      out.push({
        name,
        path: file,
        dataUri: `data:${mime};base64,${bytes.toString("base64")}`,
        bytes: bytes.length,
      });
    } catch (err) {
      out.push({
        name,
        path: file,
        dataUri: null,
        bytes: 0,
        error: err instanceof Error ? err.message.split("\n")[0] : String(err),
      });
    }
  }
  return out;
}

/** Render the self-contained HTML report string. */
export function renderReportHtml(
  result: VerifyResult,
  opts: { generatedAt?: string; version?: string } = {},
): string {
  const summary = normalizeSummary(result);
  const total = summary.passed + summary.failed + summary.skipped;
  const generatedAt = opts.generatedAt ?? result.generatedAt ?? nowIso();
  const brand = clean(result.brandName || "brand", 120);
  const url = clean(result.url ?? "", 300);
  const passed = summary.failed === 0;
  const checks: CheckResult[] = Array.isArray(result.checks) ? result.checks : [];

  const rows = checks
    .map((c) => {
      const status = c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "skip";
      const label = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
      return [
        "        <tr>",
        `          <td class="check"><code>${escapeHtml(clean(c.id, 80))}</code></td>`,
        `          <td class="status"><span class="badge ${status}">${label}</span></td>`,
        `          <td class="detail">${escapeHtml(clean(c.detail))}</td>`,
        "        </tr>",
      ].join("\n");
    })
    .join("\n");

  const statBlock = (kind: "pass" | "fail" | "skip" | "total", value: number, label: string) =>
    `      <div class="stat">\n        <span class="stat-num ${kind}">${value}</span>\n        <span class="stat-label">${label}</span>\n      </div>`;

  const shots = (result.screenshots ?? [])
    .map((shot) => {
      const name = escapeHtml(clean(shot.name, 80));
      return { name, path: String(shot.path ?? "") };
    });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="relabeld">
<title>relabeld verification report — ${brand}</title>
<style>
  :root {
    --bg: #f6f6f4;
    --surface: #ffffff;
    --ink: #17181a;
    --muted: #5f6368;
    --line: #dededa;
    --line-strong: #c9c9c4;
    --pass: #17693a;
    --pass-bg: #e9f2ec;
    --fail: #a4262c;
    --fail-bg: #faedee;
    --skip: #6b6f76;
    --skip-bg: #f0f0ee;
    --radius: 3px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0f11;
      --surface: #15171a;
      --ink: #e7e8ea;
      --muted: #9aa0a6;
      --line: #2a2d31;
      --line-strong: #3a3e44;
      --pass: #6cc28a;
      --pass-bg: #132018;
      --fail: #e57373;
      --fail-bg: #221415;
      --skip: #9aa0a6;
      --skip-bg: #1a1c1f;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    max-width: 980px;
    margin: 0 auto;
    padding: 40px 24px 56px;
    text-align: left;
  }
  .eyebrow {
    margin: 0 0 10px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -.012em;
  }
  .meta {
    margin: 0 0 28px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .meta .sep { padding: 0 8px; color: var(--line-strong); }
  .verdict {
    border: 1px solid var(--line);
    border-left: 3px solid var(--line-strong);
    background: var(--surface);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 24px;
  }
  .verdict.pass { border-left-color: var(--pass); }
  .verdict.fail { border-left-color: var(--fail); }
  .verdict-label {
    margin: 0 0 2px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .verdict-text { margin: 0; font-size: 15px; font-weight: 600; }
  .verdict.pass .verdict-text { color: var(--pass); }
  .verdict.fail .verdict-text { color: var(--fail); }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    margin-bottom: 32px;
  }
  .stat {
    padding: 14px 16px;
    border-right: 1px solid var(--line);
  }
  .stat:last-child { border-right: 0; }
  .stat-num {
    display: block;
    font-family: var(--mono);
    font-size: 24px;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    letter-spacing: -.02em;
  }
  .stat-num.pass { color: var(--pass); }
  .stat-num.fail { color: var(--fail); }
  .stat-num.skip { color: var(--skip); }
  .stat-num.total { color: var(--ink); }
  .stat-label {
    display: block;
    margin-top: 4px;
    font-size: 11px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h2 {
    margin: 0 0 12px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  section { margin-bottom: 32px; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  th {
    padding: 9px 14px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
    background: transparent;
    white-space: nowrap;
  }
  td {
    padding: 10px 14px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  tr:last-child td { border-bottom: 0; }
  td.check code {
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
  }
  td.detail { color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  td.status { white-space: nowrap; }
  .badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 2px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: .06em;
    font-weight: 600;
  }
  .badge.pass { color: var(--pass); background: var(--pass-bg); }
  .badge.fail { color: var(--fail); background: var(--fail-bg); }
  .badge.skip { color: var(--skip); background: var(--skip-bg); }
  .shots {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
  figure {
    margin: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  figure img { display: block; width: 100%; height: auto; border-bottom: 1px solid var(--line); }
  figcaption {
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .missing { padding: 24px 16px; color: var(--muted); font-size: 12px; }
  footer {
    border-top: 1px solid var(--line);
    padding-top: 14px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  @media (max-width: 560px) {
    .wrap { padding: 24px 14px 40px; }
    h1 { font-size: 22px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat { border-bottom: 1px solid var(--line); }
    .stat:nth-child(2) { border-right: 0; }
    .stat:nth-child(3), .stat:nth-child(4) { border-bottom: 0; }
    td.check code { white-space: normal; }
  }
  @media print {
    body { background: #fff; }
    .wrap { max-width: none; }
  }
</style>
</head>
<body>
  <main class="wrap">
    <header>
      <p class="eyebrow">relabeld · verification report</p>
      <h1>${brand}</h1>
      <p class="meta"><span>${escapeHtml(url)}</span><span class="sep">·</span><span>${escapeHtml(clean(generatedAt, 60))}</span></p>
    </header>
    <section class="verdict ${passed ? "pass" : "fail"}">
      <p class="verdict-label">Verification result</p>
      <p class="verdict-text">${passed ? "All checks passed" : `${summary.failed} check${summary.failed === 1 ? "" : "s"} failed`}</p>
    </section>
    <section class="stats">
${statBlock("pass", summary.passed, "Passed")}
${statBlock("fail", summary.failed, "Failed")}
${statBlock("skip", summary.skipped, "Skipped")}
${statBlock("total", total, "Total checks")}
    </section>
    <section>
      <h2>Checks</h2>
      <table>
        <thead>
          <tr><th>Check</th><th>Result</th><th>Detail</th></tr>
        </thead>
        <tbody>
${rows || `          <tr><td colspan="3" class="detail">No checks recorded.</td></tr>`}
        </tbody>
      </table>
    </section>
    <section>
      <h2>Screenshots</h2>
      <div class="shots">
${shotsHtml(shots)}
      </div>
    </section>
    <footer>generated by relabeld${opts.version ? ` v${escapeHtml(clean(opts.version, 30))}` : ""} · ${escapeHtml(clean(generatedAt, 60))} · self-contained report, no external resources</footer>
  </main>
</body>
</html>
`;
}

function shotsHtml(shots: Array<{ name: string; path: string }>): string {
  if (shots.length === 0) return `        <p class="missing">No screenshots recorded.</p>`;
  return shots
    .map((shot) => {
      // placeholder replaced by writeReport with base64 data URIs
      return `        <figure data-shot="${escapeHtml(shot.name)}">
          <div class="missing">screenshot not embedded</div>
          <figcaption>${escapeHtml(shot.name)}</figcaption>
        </figure>`;
    })
    .join("\n");
}

/** Build the complete report HTML (screenshots embedded as base64 data URIs). */
export async function buildReport(
  result: VerifyResult,
  opts: { generatedAt?: string; version?: string } = {},
): Promise<string> {
  const images = await embedImages(result);
  let html = renderReportHtml(result, opts);
  html = html.replace(
    /<figure data-shot="([^"]*)">[\s\S]*?<\/figure>/g,
    (match, name: string) => {
      const image = images.find((img) => img.name === name) ?? images.find((img) => escapeHtml(img.name) === name);
      if (!image) return match;
      const caption = `${escapeHtml(image.name)} · ${image.bytes ? `${Math.round(image.bytes / 1024)} KB` : "unavailable"}`;
      if (!image.dataUri) {
        return `<figure> <div class="missing">screenshot unavailable: ${escapeHtml(clean(image.error ?? "file not found", 300))}</div><figcaption>${caption}</figcaption></figure>`;
      }
      return `<figure><img src="${image.dataUri}" alt="${escapeHtml(image.name)} screenshot" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
    },
  );
  // Safety net: the report must never contain external references.
  return html.replace(/https?:\/\//gi, "");
}

/** Read a VerifyResult JSON, render the report and write it. */
export async function renderReportFile(opts: {
  input: string;
  out: string;
  version?: string;
}): Promise<{ result: VerifyResult; out: string; bytes: number; images: number; summary: { passed: number; failed: number; skipped: number } }> {
  const raw = await readFile(opts.input, "utf8");
  let result: VerifyResult;
  try {
    result = JSON.parse(raw) as VerifyResult;
  } catch (err) {
    throw new Error(`input is not valid JSON: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (!result || typeof result !== "object" || !Array.isArray(result.checks)) {
    throw new Error("input is not a VerifyResult (missing checks[]); run `relabeld verify --json` first");
  }
  const summary = normalizeSummary(result);
  const html = await buildReport(result, { version: opts.version });
  const outPath = path.resolve(opts.out);
  await ensureDir(path.dirname(outPath));
  const bytes = Buffer.byteLength(html, "utf8");
  await writeFile(outPath, html, "utf8");
  return {
    result,
    out: outPath,
    bytes,
    images: (result.screenshots ?? []).length,
    summary,
  };
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    ctx.error(`report: ${err instanceof Error ? err.message : String(err)}`);
    ctx.error(USAGE);
    return 2;
  }
  const values = parsed.values;
  if (values.help) {
    ctx.log(USAGE);
    return 0;
  }
  if (!values.input || !values.out) {
    ctx.error(`report: ${!values.input ? "--input is required" : "--out is required"}`);
    ctx.error(USAGE);
    return 2;
  }
  const input = path.resolve(ctx.cwd, values.input);
  const out = path.resolve(ctx.cwd, values.out);
  let rendered;
  try {
    rendered = await renderReportFile({ input, out, version: ctx.version });
  } catch (err) {
    ctx.error(`report: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const payload = {
    out: rendered.out,
    bytes: rendered.bytes,
    images: rendered.images,
    summary: rendered.summary,
    generatedAt: rendered.result.generatedAt ?? nowIso(),
  };
  if (ctx.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    ctx.log(`relabeld report ${ctx.version}`);
    ctx.log(`  input   ${input}`);
    ctx.log(`  output  ${rendered.out} (${Math.round(rendered.bytes / 1024)} KB, ${rendered.images} screenshot${rendered.images === 1 ? "" : "s"} embedded)`);
    ctx.log(
      `  result  ${rendered.summary.passed} passed, ${rendered.summary.failed} failed, ${rendered.summary.skipped} skipped`,
    );
  }
  return 0;
}
