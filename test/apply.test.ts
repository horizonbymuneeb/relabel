import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { run as applyRun } from "../dist/apply.js";
import { run as initRun } from "../dist/init.js";
import { walkRepo } from "../dist/scan.js";
import { sha256 } from "../dist/util.js";
import type { Ctx } from "../dist/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(ROOT, "test/fixtures/demo-app");
const CLI = path.join(ROOT, "dist/cli.js");

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-apply-"));
  tempDirs.push(dir);
  const copy = path.join(dir, "demo-app");
  await cp(FIXTURE, copy, { recursive: true });
  await rm(path.join(copy, "brand.yaml"), { force: true });
  await rm(path.join(copy, "docker-compose.relabel.yml"), { force: true });
  await rm(path.join(copy, ".relabel"), { recursive: true, force: true });
  return copy;
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

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files = await walkRepo(dir);
  const out: Record<string, string> = {};
  for (const file of files) {
    out[path.relative(dir, file).split(path.sep).join("/")] = sha256(await readFile(file));
  }
  return out;
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), "utf8");
}

const INIT_ARGS = ["--name", "Nova Demo", "--domain", "demo.example.com", "--primary", "#2563EB"];

async function initWithBrand(copy: string): Promise<void> {
  const { ctx, errors } = makeCtx(ROOT);
  const code = await initRun([copy, ...INIT_ARGS], ctx);
  assert.equal(code, 0, errors.join("\n"));
}

test("init: writes brand.yaml derived from the scan", async () => {
  const copy = await workspace();
  const { ctx, errors, logs } = makeCtx(ROOT);
  const code = await initRun([copy, ...INIT_ARGS], ctx);
  assert.equal(code, 0, errors.join("\n"));
  assert.ok(logs.some((line) => line.includes("wrote brand.yaml")));

  const brand = YAML.parse(await read(copy, "brand.yaml")) as Record<string, unknown>;
  assert.equal(brand.name, "Nova Demo");
  assert.equal(brand.domain, "demo.example.com");
  assert.deepEqual(brand.palette, { primary: "#2563EB" });
  assert.deepEqual(brand.variants, ["Pulse Status"]);
  assert.deepEqual(brand.keep, ["LICENSE"]);
});

test("init: JSON mode prints one object and refuses to clobber without --force", async () => {
  const copy = await workspace();
  const first = await captureStdout(() => initRun([copy, ...INIT_ARGS, "--json"], makeCtx(ROOT, true).ctx));
  assert.equal(first.code, 0);
  const payload = JSON.parse(first.out) as { path: string; brand: Record<string, unknown> };
  assert.ok(payload.path.endsWith("brand.yaml"));
  assert.equal(payload.brand.name, "Nova Demo");

  const again = makeCtx(ROOT);
  assert.equal(await initRun([copy, ...INIT_ARGS], again.ctx), 1);
  assert.match(again.errors.join(" "), /already exists/);

  const forced = makeCtx(ROOT);
  assert.equal(await initRun([copy, ...INIT_ARGS, "--force"], forced.ctx), 0);
});

test("apply --dry-run: reports changes, writes nothing at all", async () => {
  const copy = await workspace();
  await initWithBrand(copy);
  const before = await snapshot(copy);

  const { ctx, errors } = makeCtx(ROOT, true);
  const result = await captureStdout(() => applyRun([copy, "--brand", "brand.yaml", "--dry-run", "--json"], ctx));
  assert.equal(result.code, 0, errors.join("\n"));
  assert.equal(Object.keys(before).length, 12, "brand.yaml is part of the tree now");

  const payload = JSON.parse(result.out) as {
    dryRun: boolean;
    changed: Array<{ file: string; replacements: number }>;
    skipped: Array<{ file: string; reason: string }>;
    totals: { filesChanged: number; replacements: number };
  };
  assert.equal(payload.dryRun, true);
  assert.equal(payload.totals.filesChanged, 9);
  assert.equal(payload.totals.replacements, 23);
  assert.ok(payload.changed.some((entry) => entry.file === "index.html" && entry.replacements === 5));
  assert.ok(payload.skipped.some((entry) => entry.file === "LICENSE" && /license/.test(entry.reason)));
  assert.ok(payload.skipped.some((entry) => entry.file === "index.html" && /copyright/.test(entry.reason)));

  const after = await snapshot(copy);
  assert.deepEqual(after, before, "dry-run must not modify a single byte");
  await assert.rejects(stat(path.join(copy, "docker-compose.relabel.yml")));
  assert.ok(!Object.keys(after).includes("docker-compose.relabel.yml"));
});

test("apply: patches strings case-preservingly and never touches the license", async () => {
  const copy = await workspace();
  await initWithBrand(copy);
  const licenseBefore = await read(copy, "LICENSE");
  const licenseHash = sha256(licenseBefore);

  const { ctx, errors, logs } = makeCtx(ROOT);
  const code = await applyRun([copy, "--brand", "brand.yaml"], ctx);
  assert.equal(code, 0, errors.join("\n"));
  assert.ok(logs.some((line) => line.includes("changed 9 files, 23 replacements")));

  const index = await read(copy, "index.html");
  assert.match(index, /<title>Nova Demo — uptime dashboards<\/title>/);
  assert.match(index, /<h1>Nova Demo<\/h1>/);
  assert.match(index, /alt="Nova Demo logo"/);
  assert.match(index, /<code>nova-demo<\/code>/);
  assert.match(index, /© 2024 Pulse Status\. All rights reserved\./, "copyright line must stay");
  assert.ok(!index.includes("Pulse Status keeps every service"), "body string was replaced");

  const pkg = JSON.parse(await read(copy, "package.json")) as Record<string, unknown>;
  assert.equal(pkg.name, "nova-demo");
  assert.match(String(pkg.description), /Nova Demo/);

  assert.match(await read(copy, ".env.example"), /^APP_NAME=Nova Demo$/m);
  assert.match(await read(copy, "app.json"), /"name": "Nova Demo"/);
  assert.match(await read(copy, "README.md"), /^# Nova Demo$/m);
  assert.match(await read(copy, "src/styles.css"), /--brand-name: "Nova Demo"/);
  assert.match(await read(copy, "public/logo.svg"), /Nova Demo/);

  assert.equal(sha256(await read(copy, "LICENSE")), licenseHash, "LICENSE bytes must be identical");

  const compose = YAML.parse(await read(copy, "docker-compose.yml")) as {
    services: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(compose.services), ["nova-demo"]);

  const overlay = YAML.parse(await read(copy, "docker-compose.relabel.yml")) as {
    "x-relabeld": { brand: string; source: string };
    services: Record<string, { container_name?: string; environment?: Record<string, string> }>;
  };
  assert.equal(overlay["x-relabeld"].brand, "Nova Demo");
  assert.equal(overlay["x-relabeld"].source, "docker-compose.yml");
  assert.deepEqual(Object.keys(overlay.services), ["nova-demo"]);
  assert.equal(overlay.services["nova-demo"].environment?.APP_NAME, "Nova Demo");
});

test("apply: a second run is a no-op (deterministic)", async () => {
  const copy = await workspace();
  await initWithBrand(copy);
  assert.equal(await applyRun([copy, "--brand", "brand.yaml"], makeCtx(ROOT).ctx), 0);
  const firstPass = await snapshot(copy);

  const second = await captureStdout(() =>
    applyRun([copy, "--brand", "brand.yaml", "--json"], makeCtx(ROOT, true).ctx),
  );
  assert.equal(second.code, 0);
  const payload = JSON.parse(second.out) as {
    changed: unknown[];
    totals: { filesChanged: number; replacements: number };
  };
  assert.deepEqual(payload.changed, []);
  assert.equal(payload.totals.replacements, 0);
  assert.deepEqual(await snapshot(copy), firstPass);
});

test("apply: copies brand logo over detected logo targets only", async () => {
  const copy = await workspace();
  const source = path.join(path.dirname(copy), "brand-logo.svg");
  const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#2563EB"/></svg>\n';
  await writeFile(source, logoSvg, "utf8");
  const faviconBefore = await read(copy, "public/favicon.svg");

  const init = makeCtx(ROOT);
  assert.equal(await initRun([copy, ...INIT_ARGS, "--logo", source], init.ctx), 0, init.errors.join("\n"));
  const brand = YAML.parse(await read(copy, "brand.yaml")) as { logo: string };
  assert.equal(brand.logo, source, "logo outside the repo is stored as an absolute path");

  const { ctx, errors } = makeCtx(ROOT, true);
  const result = await captureStdout(() => applyRun([copy, "--brand", "brand.yaml", "--json"], ctx));
  assert.equal(result.code, 0, errors.join("\n"));
  const payload = JSON.parse(result.out) as {
    assets: Array<{ kind: string; file: string; from: string; written: boolean }>;
  };
  assert.deepEqual(payload.assets.map((asset) => asset.file), ["public/logo.svg"]);
  assert.equal(payload.assets[0].kind, "logo");
  assert.equal(payload.assets[0].written, true);
  assert.equal(await read(copy, "public/logo.svg"), logoSvg);
  assert.equal(await read(copy, "public/favicon.svg"), faviconBefore, "favicon untouched without --favicon");
});

test("apply: usage and error exit codes", async () => {
  const copy = await workspace();

  const noBrand = makeCtx(ROOT);
  assert.equal(await applyRun([copy], noBrand.ctx), 1);
  assert.match(noBrand.errors.join(" "), /brand file not found/);

  await writeFile(path.join(copy, "brand.yaml"), "domain: demo.example.com\n", "utf8");
  const invalid = makeCtx(ROOT);
  assert.equal(await applyRun([copy, "--brand", "brand.yaml"], invalid.ctx), 1);
  assert.match(invalid.errors.join(" "), /name is required/);

  const badFlag = makeCtx(ROOT);
  assert.equal(await applyRun([copy, "--dryrun"], badFlag.ctx), 2);
  assert.match(badFlag.errors.join(" "), /unknown option/);
});

test("cli: init + apply end-to-end through the real CLI", async () => {
  const copy = await workspace();
  execFileSync(process.execPath, [CLI, "init", copy, ...INIT_ARGS], { encoding: "utf8", cwd: ROOT });

  const dry = execFileSync(
    process.execPath,
    [CLI, "apply", copy, "--brand", "brand.yaml", "--dry-run", "--json"],
    { encoding: "utf8", cwd: ROOT },
  );
  const dryPayload = JSON.parse(dry) as { dryRun: boolean; totals: { filesChanged: number } };
  assert.equal(dryPayload.dryRun, true);
  assert.equal(dryPayload.totals.filesChanged, 9);
  await assert.rejects(stat(path.join(copy, "docker-compose.relabel.yml")));

  execFileSync(process.execPath, [CLI, "apply", copy, "--brand", "brand.yaml"], { encoding: "utf8", cwd: ROOT });
  const pkg = JSON.parse(await read(copy, "package.json")) as Record<string, unknown>;
  assert.equal(pkg.name, "nova-demo");
  assert.ok((await stat(path.join(copy, "docker-compose.relabel.yml"))).isFile());

  let status = 0;
  try {
    execFileSync(process.execPath, [CLI, "apply", copy, "--brand", "does-not-exist.yaml"], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: "pipe",
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? -1;
  }
  assert.equal(status, 1, "missing brand file exits 1");
});
