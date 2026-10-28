import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReport, renderReportHtml, run } from "../dist/report.js";
import type { Ctx, VerifyResult } from "../dist/types.js";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function sampleResult(shotsDir: string): VerifyResult {
  return {
    url: "https://status.example.com/app?token=abc",
    brandName: "Nova Status",
    checks: [
      { id: "brand-strings", title: "old brand strings absent", status: "pass", detail: "0 occurrences across 2 old-brand variants" },
      { id: "brand-title", title: "new brand in <title>", status: "pass", detail: 'desktop: "Nova Status"' },
      { id: "console-errors", title: "no console/page errors", status: "pass", detail: "0 page errors, 0 console errors" },
      { id: "overflow-desktop", title: "no horizontal overflow", status: "pass", detail: "scrollWidth 1440 − innerWidth 1440 = 0" },
      { id: "overflow-mobile", title: "no horizontal overflow", status: "pass", detail: "scrollWidth 390 − innerWidth 390 = 0" },
      { id: "screenshots", title: "desktop + mobile screenshots", status: "pass", detail: "saved desktop (90 bytes), mobile (90 bytes)" },
      {
        id: "favicon",
        title: "favicon matches brand asset",
        status: "fail",
        detail: "sha256 mismatch: page 9f2c1a3d4e5b… ≠ brand 0011aabbccdd… (see https://example.com/favicon.ico)",
      },
    ],
    screenshots: [
      { name: "desktop", path: path.join(shotsDir, "desktop.png") },
      { name: "mobile", path: path.join(shotsDir, "mobile.png") },
    ],
    summary: { passed: 6, failed: 1, skipped: 0 },
    generatedAt: "2026-10-29T00:00:00.000Z",
  };
}

function makeCtx(json = false): Ctx & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd: process.cwd(),
    json,
    version: "0.1.0-test",
    log: (msg: string) => lines.push(msg),
    error: (msg: string) => errors.push(msg),
    lines,
    errors,
  };
}

async function makeFixture(): Promise<{ dir: string; input: string; html: string; result: VerifyResult }> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-report-"));
  const shots = path.join(dir, "shots");
  await writeFile(path.join(shots, "desktop.png"), PNG).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shots, { recursive: true });
    await writeFile(path.join(shots, "desktop.png"), PNG);
  });
  await writeFile(path.join(shots, "mobile.png"), PNG);
  const result = sampleResult(shots);
  const input = path.join(dir, "verify.json");
  await writeFile(input, JSON.stringify(result, null, 2), "utf8");
  return { dir, input, html: path.join(dir, "report.html"), result };
}

test("report renders a self-contained HTML file with inline CSS and base64 screenshots", async () => {
  const { dir, input, html } = await makeFixture();
  try {
    const ctx = makeCtx(false);
    const code = await run(["--input", input, "--out", html], ctx);
    assert.equal(code, 0, ctx.errors.join("; "));
    const out = await readFile(html, "utf8");

    assert.match(out, /^<!doctype html>/i);
    assert.match(out, /<style>[\s\S]*prefers-color-scheme[\s\S]*<\/style>/);
    assert.match(out, /Nova Status/);
    assert.match(out, /data:image\/png;base64,/);
    assert.equal(out.split("data:image/png;base64,").length - 1, 2, "both screenshots embedded as data URIs");
    assert.ok(out.includes(PNG.toString("base64")), "PNG bytes embedded verbatim");
    assert.match(out, /PASS/);
    assert.match(out, /FAIL/);
    assert.match(out, /class="badge fail"/);
    assert.match(out, /brand-strings/);
    assert.match(out, /favicon/);
    // tabular numbers + hairline design tokens
    assert.match(out, /font-variant-numeric:\s*tabular-nums/);
    assert.match(out, /--line:/);
    assert.match(out, /border-left:\s*3px solid/);
    // self-contained: no external references, no scripts, no remote assets
    assert.equal((out.match(/https?:\/\//gi) ?? []).length, 0, "report must contain zero http(s) URLs");
    assert.doesNotMatch(out, /<script/i);
    assert.doesNotMatch(out, /<link\b/i);
    assert.doesNotMatch(out, /@import/i);
    assert.doesNotMatch(out, /url\(/i);
    assert.doesNotMatch(out, /(?:src|href)="\/\//i);
    assert.ok(ctx.lines.some((l) => l.includes("output")), "human mode reports the output path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report --json prints exactly one JSON object with the summary", async () => {
  const { dir, input, html } = await makeFixture();
  try {
    const ctx = makeCtx(true);
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["--input", input, "--out", html, "--json"], ctx);
    } finally {
      console.log = original;
    }
    assert.equal(code, 0);
    assert.equal(logs.length, 1, "exactly one JSON object");
    const payload = JSON.parse(logs[0]) as {
      out: string;
      bytes: number;
      images: number;
      summary: { passed: number; failed: number; skipped: number };
    };
    assert.equal(payload.out, html);
    assert.ok(payload.bytes > 1000);
    assert.equal(payload.images, 2);
    assert.deepEqual(payload.summary, { passed: 6, failed: 1, skipped: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report handles pass-only results and missing screenshot files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-report-missing-"));
  try {
    const result = sampleResult(path.join(dir, "nowhere"));
    result.checks = result.checks.filter((c) => c.status === "pass");
    result.summary = { passed: result.checks.length, failed: 0, skipped: 0 };
    const html = await buildReport(result, { version: "0.1.0-test" });
    assert.match(html, /All checks passed/);
    assert.match(html, /screenshot unavailable/);
    assert.equal((html.match(/https?:\/\//gi) ?? []).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderReportHtml strips URL schemes from all user-controlled text", () => {
  const result: VerifyResult = {
    url: "https://status.example.com/x",
    brandName: "Nova Status",
    checks: [
      { id: "brand-strings", title: "t", status: "fail", detail: "found https://old.example.com/foo" },
      { id: "favicon", title: "f", status: "skip", detail: "http://example.com/favicon.ico" },
    ],
    screenshots: [],
    summary: { passed: 0, failed: 1, skipped: 1 },
    generatedAt: "2026-10-29T00:00:00.000Z",
  };
  const html = renderReportHtml(result);
  assert.equal((html.match(/https?:\/\//gi) ?? []).length, 0);
  assert.match(html, /old\.example\.com\/foo/);
  assert.match(html, /status\.example\.com\/x/);
});

test("report usage and invalid input exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-report-usage-"));
  try {
    const ctx = makeCtx(false);
    assert.equal(await run([], ctx), 2);
    assert.equal(await run(["--input", "x.json"], ctx), 2);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    assert.equal(await run(["--input", bad, "--out", path.join(dir, "o.html")], ctx), 2);
    const notResult = path.join(dir, "not-result.json");
    await writeFile(notResult, JSON.stringify({ hello: "world" }), "utf8");
    assert.equal(await run(["--input", notResult, "--out", path.join(dir, "o.html")], ctx), 2);
    assert.ok(ctx.errors.length >= 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
