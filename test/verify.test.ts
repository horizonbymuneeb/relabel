import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { formatChecks, run, verifyPage } from "../dist/verify.js";
import type { Ctx, VerifyResult } from "../dist/types.js";

const EXPECTED_IDS = [
  "brand-strings",
  "brand-title",
  "console-errors",
  "overflow-desktop",
  "overflow-mobile",
  "screenshots",
  "favicon",
];

const GOOD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Nova Status</title>
  <link rel="icon" href="/favicon.ico">
  <style>html, body { margin: 0; padding: 0; }</style>
</head>
<body>
  <h1>Nova Status</h1>
  <p>All systems operational.</p>
</body>
</html>`;

const BAD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Uptime Kuma — monitor</title>
  <link rel="icon" href="/favicon.ico">
  <style>html, body { margin: 0; padding: 0; } .wide { width: 3000px; height: 10px; }</style>
</head>
<body>
  <h1>Uptime Kuma</h1>
  <div class="wide"></div>
  <script>console.error("fixture boom");</script>
</body>
</html>`;

const GOOD_ICON = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0]);
const OTHER_ICON = Buffer.from([0, 0, 2, 0, 2, 0, 32, 32, 0, 0, 1, 0, 32, 0, 8, 0]);

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

async function startFixture(opts: {
  page: string;
  icon: Buffer;
  faviconStatus?: number;
  noIconLink?: boolean;
}): Promise<Fixture> {
  const server: HttpServer = createHttpServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/favicon.ico") {
      if (opts.noIconLink) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
      const status = opts.faviconStatus ?? 200;
      res.writeHead(status, { "content-type": "image/x-icon" });
      res.end(status === 200 ? opts.icon : "not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(opts.page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
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

/** Capture console.log while running fn (JSON contract: exactly one object). */
async function captureJson<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const value = await fn();
    return { value, logs };
  } finally {
    console.log = original;
  }
}

async function writeBrand(dir: string, extra: Record<string, unknown> = {}): Promise<string> {
  const lines = [
    "name: Nova Status",
    "variants:",
    "  - Uptime Kuma",
    "  - UptimeKuma",
  ];
  if (extra.favicon) lines.push(`favicon: ${String(extra.favicon)}`);
  if (extra.variantsEmpty) {
    const idx = lines.indexOf("variants:");
    lines.splice(idx, 3);
  }
  const file = path.join(dir, "brand.yaml");
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

test("verify passes against a clean local fixture and prints exactly one JSON object", async () => {
  const fixture = await startFixture({ page: GOOD_PAGE, icon: GOOD_ICON });
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-good-"));
  try {
    const brand = await writeBrand(dir, { favicon: "favicon.ico" });
    await writeFile(path.join(dir, "favicon.ico"), GOOD_ICON);
    const shots = path.join(dir, "shots");
    const ctx = makeCtx(true);

    const { value: code, logs } = await captureJson(() =>
      run(["--url", fixture.url, "--brand", brand, "--shots", shots, "--json"], ctx),
    );

    assert.equal(code, 0, `expected exit 0, got ${code}: ${ctx.errors.join("; ")}`);
    assert.equal(logs.length, 1, `expected exactly one JSON object on stdout, got ${logs.length}`);
    const result = JSON.parse(logs[0]) as VerifyResult;
    assert.deepEqual(
      result.checks.map((c) => c.id),
      EXPECTED_IDS,
    );
    assert.equal(result.brandName, "Nova Status");
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.passed, 7);
    assert.equal(result.summary.skipped, 0);
    for (const check of result.checks) {
      assert.equal(check.status, "pass", `${check.id}: ${check.detail}`);
    }
    assert.equal(result.screenshots.length, 2);
    for (const shot of result.screenshots) {
      assert.ok(existsSync(shot.path), `screenshot missing: ${shot.path}`);
      assert.ok((await readFile(shot.path)).length > 0, `screenshot empty: ${shot.path}`);
    }
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify fails the brand/console/overflow/favicon checks on a dirty page", async () => {
  const fixture = await startFixture({ page: BAD_PAGE, icon: OTHER_ICON });
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-bad-"));
  try {
    const brand = await writeBrand(dir, { favicon: "favicon.ico" });
    await writeFile(path.join(dir, "favicon.ico"), GOOD_ICON);
    const ctx = makeCtx(true);
    const { value: code, logs } = await captureJson(() =>
      run(
        ["--url", fixture.url, "--brand", brand, "--shots", path.join(dir, "shots"), "--json"],
        ctx,
      ),
    );

    assert.equal(code, 1, "dirty page must exit 1");
    assert.equal(logs.length, 1);
    const result = JSON.parse(logs[0]) as VerifyResult;
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    assert.equal(byId["brand-strings"].status, "fail");
    assert.match(byId["brand-strings"].detail, /Uptime Kuma/);
    assert.equal(byId["brand-title"].status, "fail");
    assert.equal(byId["console-errors"].status, "fail");
    assert.equal(byId["overflow-desktop"].status, "fail");
    assert.equal(byId["overflow-mobile"].status, "fail");
    assert.equal(byId["favicon"].status, "fail");
    assert.equal(byId["screenshots"].status, "pass");
    assert.ok(result.summary.failed >= 5, `expected >= 5 failures, got ${result.summary.failed}`);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify skips favicon when the brand does not configure one", async () => {
  const fixture = await startFixture({ page: GOOD_PAGE, icon: GOOD_ICON });
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-skip-"));
  try {
    const brand = await writeBrand(dir);
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Uptime Kuma"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const favicon = result.checks.find((c) => c.id === "favicon");
    assert.ok(favicon);
    assert.equal(favicon.status, "skip");
    assert.match(favicon.detail, /not configured/);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.skipped, 1);
    assert.ok(brand.endsWith("brand.yaml"));
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify fails favicon when the served icon has a different hash", async () => {
  const fixture = await startFixture({ page: GOOD_PAGE, icon: OTHER_ICON });
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-icon-"));
  try {
    await writeBrand(dir, { favicon: "favicon.ico" });
    await writeFile(path.join(dir, "favicon.ico"), GOOD_ICON);
    const result = await verifyPage({
      url: fixture.url,
      brand: {
        name: "Nova Status",
        variants: ["Uptime Kuma"],
        palette: { primary: "#000" },
        favicon: "favicon.ico",
      },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const favicon = result.checks.find((c) => c.id === "favicon");
    assert.ok(favicon);
    assert.equal(favicon.status, "fail");
    assert.match(favicon.detail, /sha256 mismatch/);
    assert.equal(result.summary.failed, 1);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify usage errors exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-usage-"));
  try {
    const ctx = makeCtx(false);
    assert.equal(await run([], ctx), 2);
    assert.equal(await run(["--url", "http://127.0.0.1:1/"], ctx), 2); // missing brand.yaml
    assert.ok(ctx.errors.length > 0);
    const noUrl = makeCtx(false);
    assert.equal(await run(["--brand", path.join(dir, "missing.yaml")], noUrl), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatChecks renders a left-aligned PASS/FAIL/SKIP table", () => {
  const table = formatChecks([
    { id: "brand-strings", title: "old brand strings absent", status: "pass", detail: "0 occurrences" },
    { id: "brand-title", title: "new brand in <title>", status: "fail", detail: "title is wrong" },
    { id: "favicon", title: "favicon matches brand asset", status: "skip", detail: "not configured" },
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^STATUS\s+CHECK\s+DETAIL/);
  assert.match(lines[1], /^PASS\s+brand-strings\s+0 occurrences/);
  assert.match(lines[2], /^FAIL\s+brand-title/);
  assert.match(lines[3], /^SKIP\s+favicon/);
});
