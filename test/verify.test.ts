import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  browserCandidates,
  decodeDataUri,
  evaluateOverflow,
  formatChecks,
  isAttributionLine,
  isImplicitFaviconNoise,
  parseIconLinkHref,
  run,
  shouldCloseBrowser,
  verifyPage,
} from "../dist/verify.js";
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
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#2563eb"/></svg>';
const SVG_BYTES = Buffer.from(SVG_TEXT, "utf8");

function pageWithIcon(href: string, extraHead = "", extraBody = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Nova Status</title>
  <link rel="icon" href="${href}">
  <style>html, body { margin: 0; padding: 0; }</style>${extraHead}
</head>
<body>
  <h1>Nova Status</h1>
  <p>All systems operational.</p>${extraBody}
</body>
</html>`;
}

/** Page with no icon link of any kind (browser may request the implicit /favicon.ico). */
function plainPage(extraHead = "", extraBody = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Nova Status</title>
  <style>html, body { margin: 0; padding: 0; }</style>${extraHead}
</head>
<body>
  <h1>Nova Status</h1>
  <p>All systems operational.</p>${extraBody}
</body>
</html>`;
}

/** Page that declares an icon in HTML, then rewrites it to a data: URI after load. */
function pageWithRewriteIcon(declaredHref: string, dataUri: string): string {
  return pageWithIcon(
    declaredHref,
    "",
    `<script>
      window.addEventListener("load", () => {
        document.querySelector('link[rel="icon"]').href = ${JSON.stringify(dataUri)};
      });
    </script>`,
  );
}

/** Page whose raw HTML has NO icon link; JS adds a runtime data: URI icon after load. */
function pageWithRuntimeOnlyIcon(dataUri: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Nova Status</title>
  <style>html, body { margin: 0; padding: 0; }</style>
</head>
<body>
  <h1>Nova Status</h1>
  <script>
    window.addEventListener("load", () => {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = ${JSON.stringify(dataUri)};
      document.head.appendChild(link);
    });
  </script>
</body>
</html>`;
}

function faviconCheck(result: VerifyResult) {
  const check = result.checks.find((c) => c.id === "favicon");
  assert.ok(check, "favicon check missing");
  return check;
}

async function brandDirWith(assets: Record<string, Buffer | string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-favicon-"));
  for (const [name, body] of Object.entries(assets)) {
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}

/** Run verifyPage for one fixture and return the favicon check + the whole result. */
async function faviconCase(opts: {
  page: string;
  files?: Record<string, { body: Buffer | string; status?: number; type?: string }>;
  icon?: Buffer;
  brand: { favicon?: string; logo?: string };
  assets: Record<string, Buffer | string>;
}): Promise<{ check: ReturnType<typeof faviconCheck>; result: VerifyResult; dir: string }> {
  const dir = await brandDirWith(opts.assets);
  const fixture = await startFixture({ page: opts.page, files: opts.files, icon: opts.icon });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Uptime Kuma"], palette: { primary: "#000" }, ...opts.brand },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    return { check: faviconCheck(result), result, dir };
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("favicon: data: URI matching the brand asset passes", async () => {
  const dataUri = `data:image/png;base64,${GOOD_ICON.toString("base64")}`;
  const { check } = await faviconCase({
    page: pageWithIcon(dataUri),
    brand: { favicon: "favicon.ico" },
    assets: { "favicon.ico": GOOD_ICON },
  });
  assert.equal(check.status, "pass");
  assert.match(check.detail, /data: URI/);
  assert.match(check.detail, /matches brand favicon favicon\.ico/);
});

test("favicon: percent-encoded data: URI matching the brand asset passes", async () => {
  const dataUri = `data:image/svg+xml,${encodeURIComponent(SVG_TEXT)}`;
  const { check } = await faviconCase({
    page: pageWithIcon(dataUri),
    brand: { favicon: "brand.svg" },
    assets: { "brand.svg": SVG_BYTES },
  });
  assert.equal(check.status, "pass");
  assert.match(check.detail, /data: URI/);
});

test("favicon: served-HTML icon is authoritative when JS rewrites the DOM to a data: URI", async () => {
  const runtimeDataUri = `data:image/png;base64,${OTHER_ICON.toString("base64")}`;
  const { check, result } = await faviconCase({
    page: pageWithRewriteIcon("/declared.ico", runtimeDataUri),
    icon: GOOD_ICON,
    files: { "/declared.ico": { body: GOOD_ICON, type: "image/x-icon" } },
    brand: { favicon: "favicon.ico" },
    assets: { "favicon.ico": GOOD_ICON },
  });
  assert.equal(check.status, "pass", check.detail);
  assert.match(check.detail, /HTTP 200/);
  assert.equal(result.summary.failed, 0);
});

test("favicon: runtime data: URI that differs from the brand asset is skipped, not failed", async () => {
  const runtimeDataUri = `data:image/png;base64,${OTHER_ICON.toString("base64")}`;
  const { check, result } = await faviconCase({
    page: pageWithRuntimeOnlyIcon(runtimeDataUri),
    brand: { favicon: "favicon.ico" },
    assets: { "favicon.ico": GOOD_ICON },
  });
  assert.equal(check.status, "skip", check.detail);
  assert.match(check.detail, /runtime-generated favicon \(data: URI\)/);
  assert.equal(result.summary.failed, 0);
});

test("favicon: missing icon over HTTP fails with the status code", async () => {
  const { check } = await faviconCase({
    page: pageWithIcon("/missing.ico"),
    files: { "/missing.ico": { body: "not found", status: 404 } },
    brand: { favicon: "favicon.ico" },
    assets: { "favicon.ico": GOOD_ICON },
  });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /HTTP 404/);
});

test("favicon: blob:/about: schemes are skipped with a clear detail", async () => {
  const { check } = await faviconCase({
    page: pageWithIcon("blob:https://example.invalid/0b1c2d3e"),
    brand: { favicon: "favicon.ico" },
    assets: { "favicon.ico": GOOD_ICON },
  });
  assert.equal(check.status, "skip");
  assert.match(check.detail, /scheme "blob:" is not verifiable/);
});

test("favicon: served icon may match the configured brand logo", async () => {
  const { check } = await faviconCase({
    page: pageWithIcon("/brand-logo.svg"),
    files: { "/brand-logo.svg": { body: SVG_BYTES, type: "image/svg+xml" } },
    brand: { favicon: "favicon.ico", logo: "brand-logo.svg" },
    assets: { "favicon.ico": GOOD_ICON, "brand-logo.svg": SVG_BYTES },
  });
  assert.equal(check.status, "pass", check.detail);
  assert.match(check.detail, /matches brand logo brand-logo\.svg/);
});

test("parseIconLinkHref reads raw HTML icon links only", () => {
  const html = `<!doctype html><html><head>
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    <link href="/icon.svg" rel="icon" type="image/svg+xml" />
    <link rel="icon" href="/second.ico">
  </head></html>`;
  assert.equal(parseIconLinkHref(html, "https://status.example.com/app"), "https://status.example.com/icon.svg");
  assert.equal(parseIconLinkHref('<link rel="shortcut icon" href="fav.ico">', "https://x.test/a/b"), "https://x.test/a/fav.ico");
  assert.equal(parseIconLinkHref('<link rel="stylesheet" href="/x.css">', "https://x.test/"), null);
  assert.equal(parseIconLinkHref("", "https://x.test/"), null);
  // No icon link, only touch icons.
  assert.equal(
    parseIconLinkHref('<link rel="apple-touch-icon" href="/a.png">', "https://x.test/"),
    null,
  );
});

test("decodeDataUri handles base64 and percent-encoded payloads", () => {
  assert.deepEqual(decodeDataUri(`data:image/png;base64,${GOOD_ICON.toString("base64")}`), GOOD_ICON);
  assert.deepEqual(decodeDataUri(`data:image/svg+xml,${encodeURIComponent(SVG_TEXT)}`), SVG_BYTES);
  assert.equal(decodeDataUri("data:text/plain,hello%20world").toString("utf8"), "hello world");
  assert.throws(() => decodeDataUri("https://example.com/favicon.ico"));
});


interface Fixture {
  url: string;
  close: () => Promise<void>;
}

async function startFixture(opts: {
  page: string;
  icon?: Buffer;
  faviconStatus?: number;
  files?: Record<string, { body: Buffer | string; status?: number; type?: string }>;
}): Promise<Fixture> {
  const server: HttpServer = createHttpServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const extra = opts.files?.[url];
    if (extra) {
      res.writeHead(extra.status ?? 200, {
        "content-type": extra.type ?? (typeof extra.body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream"),
      });
      res.end(extra.body);
      return;
    }
    if (url === "/favicon.ico" && opts.icon) {
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

test("brand-strings fails when no old-brand variants are configured (vacuous pass is a fail)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-novariants-"));
  const fixture = await startFixture({ page: plainPage() });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: [], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "fail");
    assert.match(check.detail, /no old-brand variants configured; run scan\/init/);
    assert.ok(result.summary.failed >= 1);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("console-errors ignores a /favicon.ico 404 resource error and reports the count", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-favnoise-"));
  const fixture = await startFixture({
    page: plainPage('<link rel="icon" href="/favicon.ico">'),
    files: { "/favicon.ico": { body: "nope", status: 404 } },
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Uptime Kuma"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "console-errors");
    assert.ok(check);
    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /ignored 1 implicit \/favicon\.ico 404/);
    assert.equal(result.summary.failed, 0, "favicon.ico noise must not fail any check");
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("console-errors still fails for non-favicon resource errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-js404-"));
  const fixture = await startFixture({
    page: plainPage("", '<script src="/missing.js"></script>'),
    files: { "/missing.js": { body: "nope", status: 404 } },
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Uptime Kuma"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "console-errors");
    assert.ok(check);
    assert.equal(check.status, "fail");
    assert.doesNotMatch(check.detail, /ignored \d+ implicit/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shouldCloseBrowser only closes browsers we launched (not --cdp sessions)", () => {
  assert.equal(shouldCloseBrowser(undefined), true);
  assert.equal(shouldCloseBrowser(""), true);
  assert.equal(shouldCloseBrowser("http://127.0.0.1:9222"), false);
  assert.equal(shouldCloseBrowser("ws://127.0.0.1:9222/devtools/browser/x"), false);
});

test("evaluateOverflow passes on zero and negative differences, fails only on positive", () => {
  const exact = evaluateOverflow(1440, 1440);
  assert.equal(exact.pass, true);
  assert.equal(exact.diff, 0);
  const negative = evaluateOverflow(1425, 1440); // classic vertical scrollbar
  assert.equal(negative.pass, true);
  assert.equal(negative.diff, -15);
  assert.match(negative.detail, /= -15$/);
  const positive = evaluateOverflow(1441, 1440);
  assert.equal(positive.pass, false);
  assert.equal(positive.diff, 1);
});

test("isImplicitFaviconNoise tolerates only resource-load failures for /favicon.ico", () => {
  const text = "Failed to load resource: the server responded with a status of 404 (Not Found)";
  assert.equal(isImplicitFaviconNoise(text, "https://status.example.com/favicon.ico"), true);
  assert.equal(isImplicitFaviconNoise(text, "https://status.example.com/favicon.ico?v=2"), true);
  assert.equal(isImplicitFaviconNoise("failed to load resource: 404", "http://127.0.0.1:1234/favicon.ico"), true);
  assert.equal(isImplicitFaviconNoise(text, "https://status.example.com/assets/missing.js"), false);
  assert.equal(isImplicitFaviconNoise(text, ""), false);
  assert.equal(isImplicitFaviconNoise("SyntaxError: unexpected token", "https://status.example.com/favicon.ico"), false);
  assert.equal(isImplicitFaviconNoise(text, "https://status.example.com/favicon.ico.png"), false);
});

test("browser candidates include Debian's /usr/bin/chromium and honour RELABEL_* env aliases", () => {
  assert.deepEqual(browserCandidates({}), [
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]);
  assert.equal(browserCandidates({ RELABEL_CHROMIUM_PATH: "/usr/bin/chromium" })[0], "/usr/bin/chromium");
  assert.equal(browserCandidates({ RELABEL_CHROME: "/opt/chrome" })[0], "/opt/chrome");
  assert.equal(
    browserCandidates({ RELABEL_CHROME: "/opt/chrome", RELABEL_CHROMIUM_PATH: "/usr/bin/chromium" })[0],
    "/opt/chrome",
    "RELABEL_CHROME wins over RELABEL_CHROMIUM_PATH",
  );
  assert.equal(
    browserCandidates({ RELABEL_CHROME: "  ", RELABEL_CHROMIUM_PATH: "/usr/bin/chromium" })[0],
    "/usr/bin/chromium",
    "blank env values are ignored",
  );
  assert.ok(browserCandidates({}).includes("/usr/bin/chromium"), "Docker image path must be a candidate");
});

test("bundled SKILL.md frontmatter advertises version 1.0.0", async () => {
  const text = await readFile(path.join(process.cwd(), "skills", "relabel", "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: relabel\n/);
  assert.match(text, /^version: 1\.0\.0$/m);
  assert.match(text, /^description: .+\.$/m);
});

test("brand-strings ignores an old brand that appears only in a preserved © line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-copyright-"));
  const fixture = await startFixture({
    page: plainPage("", "<footer><p>© 2024 Pulse Status. All rights reserved.</p></footer>"),
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /ignored 1 preserved license\/copyright/);
    assert.equal(result.summary.failed, 0);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("brand-strings still fails when the old brand is visible beside a © line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-copyright-visible-"));
  const fixture = await startFixture({
    page: plainPage(
      "",
      "<h1>Pulse Status</h1><footer><p>© 2024 Pulse Status. All rights reserved.</p></footer>",
    ),
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "fail");
    assert.match(check.detail, /1 visible occurrence/);
    assert.match(check.detail, /"Pulse Status" ×1/);
    assert.match(check.detail, /ignored 1 preserved license\/copyright/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("brand-strings ignores old-brand matches inside brand.keep entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-keep-"));
  const fixture = await startFixture({
    page: plainPage("", "<footer><p>Made by Pulse Status Labs</p></footer>"),
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: {
        name: "Nova Status",
        variants: ["Pulse Status"],
        palette: { primary: "#000" },
        keep: ["Made by Pulse Status Labs"],
      },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /ignored 1 preserved/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("brand-strings still fails for old-brand residue outside visible text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-residue-"));
  const fixture = await startFixture({
    page: plainPage("", '<script>window.__upstream = "Pulse Status";</script>'),
  });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "fail");
    assert.match(check.detail, /outside visible text/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("isAttributionLine mirrors apply/scan's license-line rule and honours brand.keep", () => {
  for (const line of [
    "Copyright 2024 Pulse Status",
    "© 2024 Pulse Status. All rights reserved.",
    "(c) 2024 Pulse Status",
    "Pulse Status (c) 2024",
    "SPDX-License-Identifier: MIT",
    "Licensed under the MIT License",
    "All rights reserved.",
  ]) {
    assert.equal(isAttributionLine(line), true, line);
  }
  // Broader than apply's rule => must NOT be exempt (would hide real stale branding):
  assert.equal(isAttributionLine("Pulse Status (c) all rights"), false);
  assert.equal(isAttributionLine("Pulse Status (c) no year"), false);
  assert.equal(isAttributionLine("license: Pulse Status"), false);
  assert.equal(isAttributionLine("SPDX-License: MIT"), false);
  assert.equal(isAttributionLine("Made by Pulse Status Labs", ["Made by Pulse Status Labs"]), true);
  assert.equal(isAttributionLine("Pulse Status", ["Made by Pulse Status Labs"]), false);
  assert.equal(isAttributionLine("Welcome to Pulse Status"), false);
  assert.equal(isAttributionLine("© 2024", []), true);
});

test("brand-strings ignores '(c) 2024'-style license lines but not '(c)' without a year", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-c-year-"));
  const fixture = await startFixture({ page: plainPage("", "<footer><p>Pulse Status (c) 2024</p></footer>") });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /ignored 1 preserved license\/copyright\/keep line/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("brand-strings fails a '(c)' line without a year (apply would not preserve it)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-c-noyear-"));
  const fixture = await startFixture({ page: plainPage("", "<footer><p>Pulse Status (c) all rights</p></footer>") });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "fail", check.detail);
    assert.match(check.detail, /1 visible occurrence/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("brand-strings fails a generic 'license:' line containing the old brand", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-verify-license-colon-"));
  const fixture = await startFixture({ page: plainPage("", "<footer><p>license: Pulse Status</p></footer>") });
  try {
    const result = await verifyPage({
      url: fixture.url,
      brand: { name: "Nova Status", variants: ["Pulse Status"], palette: { primary: "#000" } },
      brandDir: dir,
      shotsDir: path.join(dir, "shots"),
    });
    const check = result.checks.find((c) => c.id === "brand-strings");
    assert.ok(check);
    assert.equal(check.status, "fail", check.detail);
    assert.match(check.detail, /1 visible occurrence/);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
