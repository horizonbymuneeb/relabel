import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalName,
  detectInLine,
  isLicensePath,
  isScannableText,
  run as scanRun,
  scanDir,
  variantsFor,
  walkRepo,
} from "../dist/scan.js";
import type { Ctx, ScanResult } from "../dist/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(ROOT, "test/fixtures/demo-app");
const DATA_FIXTURE = path.join(ROOT, "test/fixtures/data-safety");
const CLI = path.join(ROOT, "dist/cli.js");

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-scan-"));
  tempDirs.push(dir);
  const copy = path.join(dir, "demo-app");
  await cp(FIXTURE, copy, { recursive: true });
  await rm(path.join(copy, "brand.yaml"), { force: true });
  await rm(path.join(copy, "docker-compose.relabel.yml"), { force: true });
  await rm(path.join(copy, ".relabel"), { recursive: true, force: true });
  return copy;
}

async function dataSafetyCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-data-"));
  tempDirs.push(dir);
  const copy = path.join(dir, "data-safety");
  await cp(DATA_FIXTURE, copy, { recursive: true });
  return copy;
}

/** Write a >512KiB text file containing the brand string. */
async function writeOversizeFile(dir: string): Promise<{ file: string; size: number }> {
  const file = path.join(dir, "notes/oversize.txt");
  const line = "Pulse Status oversize line\n";
  const count = Math.ceil((600 * 1024) / Buffer.byteLength(line));
  await writeFile(file, line.repeat(count), "utf8");
  return { file, size: (await stat(file)).size };
}

function makeCtx(cwd: string, json = false): { ctx: Ctx; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx: Ctx = {
    cwd,
    json,
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
    version: "test",
  };
  return { ctx, logs, errors };
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map((value) => String(value)).join(" ") + "\n";
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = original;
  }
}

test("scan: fixture yields the expected ScanResult", async () => {
  const copy = await fixtureCopy();
  const result = await scanDir(copy);

  assert.equal(result.root, path.resolve(copy));
  assert.equal(result.scannedFiles, 11, "fixture has 11 files after ignoring nothing");
  assert.deepEqual(result.brandTokens, ["Pulse Status"]);
  assert.equal(result.findings.length, 25);
  assert.deepEqual(result.summaries, {
    string: 9,
    asset: 0,
    config: 9,
    docs: 3,
    ci: 2,
    license: 2,
  });
  assert.equal(result.assets.length, 2);

  // every finding is well-formed
  for (const finding of result.findings) {
    assert.equal(typeof finding.file, "string");
    assert.ok(finding.file.length > 0);
    assert.ok(["string", "asset", "config", "docs", "ci", "license"].includes(finding.kind));
    assert.equal(typeof finding.token, "string");
    assert.ok(finding.match.length > 0);
    assert.ok(["high", "medium", "low"].includes(finding.confidence));
    if (finding.line !== undefined) assert.ok(Number.isInteger(finding.line) && finding.line > 0);
  }
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const files = new Set(result.findings.map((finding) => finding.file));
  assert.ok(files.has("index.html"));
  assert.ok(files.has(".github/workflows/ci.yml"));
  assert.ok(files.has("public/logo.svg"));
  assert.ok(files.has(".env.example"));
});

test("scan: license lines are classified license, never string", async () => {
  const copy = await fixtureCopy();
  const result = await scanDir(copy);
  const licenseFiles = [...new Set(result.findings.filter((f) => f.kind === "license").map((f) => f.file))];
  assert.deepEqual(licenseFiles.sort(), ["LICENSE", "index.html"]);
  // the copyright line in index.html is the license finding
  const indexLicense = result.findings.find((f) => f.file === "index.html" && f.kind === "license");
  assert.ok(indexLicense);
  assert.match(indexLicense.suggestion ?? "", /keep/i);
});

test("scan: assets carry kind, bytes and sha256", async () => {
  const copy = await fixtureCopy();
  const result = await scanDir(copy);
  const kinds = result.assets.map((asset) => asset.kind).sort();
  assert.deepEqual(kinds, ["favicon", "logo"]);
  for (const asset of result.assets) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.bytes > 0);
    assert.match(asset.file, /^public\//);
  }
});

test("scan: the generated brand.yaml is not reported as brand surface", async () => {
  const copy = await fixtureCopy();
  await writeFile(
    path.join(copy, "brand.yaml"),
    "name: Nova Demo\npalette:\n  primary: '#2563EB'\nvariants:\n  - Pulse Status\nkeep:\n  - LICENSE\n",
    "utf8",
  );
  const result = await scanDir(copy);
  assert.equal(result.findings.length, 25, "brand.yaml must not add findings");
  assert.ok(!result.findings.some((finding) => finding.file === "brand.yaml"));
});

test("scan: ignores node_modules, dist and .git; reads .github and LICENSE", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-ign-"));
  tempDirs.push(dir);
  const repo = path.join(dir, "acme-status");
  await mkdir(path.join(repo, "node_modules/fake"), { recursive: true });
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, ".github/workflows"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), '{"name":"acme-status"}\n');
  await writeFile(path.join(repo, "app.js"), 'const brand = "Acme Status";\n');
  await writeFile(path.join(repo, "node_modules/fake/index.js"), 'const x = "Acme Status";\n');
  await writeFile(path.join(repo, "dist/out.js"), 'const x = "Acme Status";\n');
  await writeFile(path.join(repo, ".git/config"), "acme-status\n");
  await writeFile(path.join(repo, ".github/workflows/ci.yml"), "name: ACME-STATUS ci\n");
  await writeFile(path.join(repo, "LICENSE"), "Copyright (c) 2024 Acme Status\n");

  const result = await scanDir(repo);
  assert.equal(result.scannedFiles, 4, "node_modules/dist/.git must not be walked");
  assert.deepEqual(result.brandTokens, ["Acme Status"]);
  const files = result.findings.map((finding) => finding.file).sort();
  assert.deepEqual(files, [".github/workflows/ci.yml", "LICENSE", "app.js", "package.json"]);
  assert.ok(
    !result.findings.some((finding) =>
      ["node_modules/", "dist/", ".git/"].some((prefix) => finding.file.startsWith(prefix)),
    ),
  );
  const kinds = result.findings.map((finding) => finding.kind).sort();
  assert.deepEqual(kinds, ["ci", "config", "license", "string"]);
});

test("scan: helpers behave (canonical names, variants, boundaries)", () => {
  assert.equal(canonicalName("pulse-status"), "Pulse Status");
  assert.equal(canonicalName("uptime-kuma"), "Uptime Kuma");
  assert.equal(canonicalName("BrightBean"), "BrightBean");
  assert.equal(canonicalName("brightbean-studio"), "Brightbean Studio");

  const variants = variantsFor("Pulse Status").map((variant) => variant.toLowerCase());
  for (const expected of ["pulse status", "pulse-status", "pulse_status", "pulsestatus"]) {
    assert.ok(variants.includes(expected), `variants missing ${expected}`);
  }

  assert.equal(detectInLine("prefixpulsestatussuffix", ["Pulse Status"]).length, 0, "no match inside words");
  assert.equal(detectInLine("pulse-status-worker", ["Pulse Status"]).length, 1, "dash boundaries still match");
  assert.equal(detectInLine("run pulse-status now", ["Pulse Status"]).length, 1);
  assert.equal(detectInLine("PULSE-STATUS and Pulse Status", ["Pulse Status"]).length, 2);

  assert.ok(isLicensePath("LICENSE"));
  assert.ok(isLicensePath("third_party_licenses/foo.txt"));
  assert.ok(!isLicensePath("src/app.ts"));
  assert.ok(isScannableText("static/favicon/site.webmanifest"));
  assert.ok(isScannableText("Caddyfile"));
  assert.ok(!isScannableText("src/app.ts.bak"));
});

test("scan: --save writes .relabel/scan.json and both modes stay valid", async () => {
  const copy = await fixtureCopy();
  const { ctx, errors } = makeCtx(ROOT);
  const code = await scanRun([copy, "--save"], ctx);
  assert.equal(code, 0, errors.join("\n"));
  const saved = JSON.parse(await readFile(path.join(copy, ".relabel/scan.json"), "utf8")) as ScanResult;
  assert.equal(saved.findings.length, 25);
  const rescan = await walkRepo(copy);
  assert.ok(!rescan.some((file) => file.includes(".relabel")), ".relabel must not be re-walked");

  const json = await captureStdout(() => scanRun([copy, "--json"], makeCtx(ROOT, true).ctx));
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out) as ScanResult;
  assert.equal(parsed.scannedFiles, 11);
  assert.deepEqual(parsed.brandTokens, ["Pulse Status"]);
});

test("cli: scan --json is exactly one JSON object, human mode has a summary", async () => {
  const copy = await fixtureCopy();
  const jsonOut = execFileSync(process.execPath, [CLI, "scan", copy, "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  const parsed = JSON.parse(jsonOut) as ScanResult;
  assert.ok(Array.isArray(parsed.findings));
  assert.deepEqual(parsed.brandTokens, ["Pulse Status"]);

  const human = execFileSync(process.execPath, [CLI, "scan", copy], { encoding: "utf8", cwd: ROOT });
  assert.match(human, /relabeld scan/);
  assert.match(human, /brand tokens: Pulse Status/);
  assert.match(human, /findings: string \d+/);
  assert.match(human, /assets:/);
});

test("cli: scan usage errors exit 2, missing dir exits 1", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "relabel-cli-"));
  tempDirs.push(tmp);
  assert.throws(() => execFileSync(process.execPath, [CLI, "scan", "--nope"], { encoding: "utf8", cwd: ROOT }), (error: unknown) => {
    return (error as { status?: number }).status === 2;
  });
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "scan", path.join(tmp, "missing")], { encoding: "utf8", cwd: ROOT }),
    (error: unknown) => (error as { status?: number }).status === 1,
  );
});

test("cli: fixture file set is stable (11 tracked files)", async () => {
  const entries = await readdir(FIXTURE, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(FIXTURE, path.join(entry.parentPath ?? FIXTURE, entry.name)))
    .filter((rel) => !rel.endsWith("brand.yaml") && !rel.endsWith("docker-compose.relabel.yml"))
    .sort();
  assert.deepEqual(files, [
    ".env.example",
    ".github/workflows/ci.yml",
    "LICENSE",
    "README.md",
    "app.json",
    "docker-compose.yml",
    "index.html",
    "package.json",
    "public/favicon.svg",
    "public/logo.svg",
    "src/styles.css",
  ]);
});

/* ------------------------------------------------------------------ */
/* task-14: D4/D5 data-safety accounting (invalid UTF-8 / oversize)   */
/* ------------------------------------------------------------------ */

test("scan: D4/D5 — invalid UTF-8 and oversize files are reported, never read", async () => {
  const copy = await dataSafetyCopy();
  const { size } = await writeOversizeFile(copy);
  const result = await scanDir(copy);
  const skipped = result.skipped;
  const byFile = new Map(skipped.map((entry) => [entry.file, entry]));
  assert.equal(byFile.get("notes/latin1.txt")?.reason, "invalid-utf8");
  assert.equal(byFile.get("notes/binary.txt")?.reason, "binary");
  assert.equal(byFile.get("notes/oversize.txt")?.reason, "oversize");
  assert.equal(byFile.get("notes/oversize.txt")?.bytes, size);
  assert.ok(skipped.every((entry) => entry.bytes > 0));
  assert.equal(result.maxFileBytes, 512 * 1024);
  assert.equal(result.scannedFiles, 6);

  const badFiles = ["notes/latin1.txt", "notes/binary.txt", "notes/oversize.txt"];
  assert.ok(!result.findings.some((finding) => badFiles.includes(finding.file)));
  assert.ok(result.findings.some((finding) => finding.file === "notes/valid.txt"));

  const human = makeCtx(ROOT);
  assert.equal(await scanRun([copy], human.ctx), 0);
  const output = human.logs.join("\n");
  assert.match(output, /skipped 3 files/);
  assert.match(output, /not valid UTF-8 \(binary\/latin1\)/);
  assert.match(output, /oversize \(/);
  assert.match(output, /--max-file-bytes/);
});

test("scan: --max-file-bytes raises the text limit (invalid UTF-8 still skipped)", async () => {
  const copy = await dataSafetyCopy();
  await writeOversizeFile(copy);

  const raised = await scanDir(copy, { maxFileBytes: 1024 * 1024 });
  assert.equal(raised.maxFileBytes, 1024 * 1024);
  assert.ok(!raised.skipped.some((entry) => entry.file === "notes/oversize.txt"));
  assert.ok(raised.findings.some((finding) => finding.file === "notes/oversize.txt"));
  assert.ok(raised.skipped.some((entry) => entry.file === "notes/latin1.txt"));

  const json = await captureStdout(() =>
    scanRun([copy, "--max-file-bytes", "1048576", "--json"], makeCtx(ROOT, true).ctx),
  );
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.out) as {
    maxFileBytes: number;
    skipped: Array<{ file: string }>;
    findings: Array<{ file: string }>;
  };
  assert.equal(payload.maxFileBytes, 1048576);
  assert.ok(!payload.skipped.some((entry) => entry.file === "notes/oversize.txt"));
  assert.ok(payload.findings.some((finding) => finding.file === "notes/oversize.txt"));

  const bad = makeCtx(ROOT);
  assert.equal(await scanRun([copy, "--max-file-bytes", "nope"], bad.ctx), 2);
  assert.match(bad.errors.join(" "), /positive integer/);
});
