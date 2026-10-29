import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
const MODULE_FIXTURE = path.join(ROOT, "test/fixtures/module-app");
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


async function moduleWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-module-"));
  tempDirs.push(dir);
  const copy = path.join(dir, "module-app");
  await cp(MODULE_FIXTURE, copy, { recursive: true });
  await rm(path.join(copy, "brand.yaml"), { force: true });
  await rm(path.join(copy, "docker-compose.relabel.yml"), { force: true });
  await rm(path.join(copy, ".relabel"), { recursive: true, force: true });
  return copy;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Build a recipe.yaml for the module-app fixture (pulse-status). */
function recipeYaml(options: { renames?: Array<[string, string]>; files?: string[] } = {}): string {
  const renames = options.renames ?? [["server/pulse-status-server.js", "server/{{slug}}-server.js"]];
  const lines = [
    "id: pulse-status",
    "name: Pulse Status",
    "upstream: https://example.com/pulse-status",
    "match:",
    "  - package.json",
    "  - README.md",
    "  - server/",
    "  - Dockerfile",
    "strings:",
    "  - Pulse Status",
    "  - pulse-status",
    "assets: []",
    "renames:",
  ];
  for (const [from, to] of renames) lines.push(`  - from: ${from}`, `    to: "${to}"`);
  if (options.files?.length) {
    lines.push("files:");
    for (const file of options.files) lines.push(`  - path: ${file}`, "    replace: []");
  }
  return lines.join("\n") + "\n";
}

async function recipeLibrary(contents = recipeYaml()): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-lib-"));
  tempDirs.push(dir);
  const recipeDir = path.join(dir, "pulse-status");
  await mkdir(recipeDir, { recursive: true });
  await writeFile(path.join(recipeDir, "recipe.yaml"), contents, "utf8");
  return dir;
}

async function withRecipeLibrary<T>(library: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.RELABELD_RECIPES_DIR;
  process.env.RELABELD_RECIPES_DIR = library;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RELABELD_RECIPES_DIR;
    else process.env.RELABELD_RECIPES_DIR = previous;
  }
}

interface ApplyPayload {
  dryRun: boolean;
  recipe: { id: string; name: string; source: string; auto: boolean } | null;
  changed: Array<{ file: string; replacements: number }>;
  skipped: Array<{ file: string; reason: string; lines?: number }>;
  renames: Array<{ from: string; to: string; status: string; written: boolean }>;
  warnings: string[];
  compose: { file: string; service: string; newService: string } | null;
  totals: { filesChanged: number; replacements: number; renamesPerformed: number };
}

async function applyJson(copy: string, extraArgs: string[] = []): Promise<{ code: number; payload: ApplyPayload; errors: string[] }> {
  const { ctx, errors } = makeCtx(ROOT, true);
  const result = await captureStdout(() =>
    applyRun([copy, "--brand", "brand.yaml", "--json", ...extraArgs], ctx),
  );
  return { code: result.code, payload: JSON.parse(result.out) as ApplyPayload, errors };
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
  assert.equal(payload.totals.replacements, 22); // docker-compose image: line is preserved
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
  assert.ok(logs.some((line) => line.includes("changed 9 files, 22 replacements")));

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

/* ------------------------------------------------------------------ */
/* task-6: recipe renames + docker image refs                         */
/* ------------------------------------------------------------------ */

test("init: --from is the MCP source-dir alias; positional wins when both are given", async () => {
  const first = await moduleWorkspace();
  const viaFrom = makeCtx(ROOT);
  assert.equal(await initRun(["--from", first, ...INIT_ARGS], viaFrom.ctx), 0, viaFrom.errors.join("\n"));
  const brand = YAML.parse(await read(first, "brand.yaml")) as { name: string };
  assert.equal(brand.name, "Nova Demo");

  const second = await moduleWorkspace();
  const viaPositional = makeCtx(ROOT);
  const code = await initRun(
    [second, "--from", first, "--name", "Positional Brand", "--primary", "#111111"],
    viaPositional.ctx,
  );
  assert.equal(code, 0, viaPositional.errors.join("\n"));
  const secondBrand = YAML.parse(await read(second, "brand.yaml")) as { name: string };
  assert.equal(secondBrand.name, "Positional Brand", "positional dir wins over --from");
  assert.equal((YAML.parse(await read(first, "brand.yaml")) as { name: string }).name, "Nova Demo");

  const third = await moduleWorkspace();
  const missingValue = makeCtx(ROOT);
  assert.equal(await initRun([third, "--from"], missingValue.ctx), 2);
  assert.match(missingValue.errors.join(" "), /--from requires a directory/);
});

test("apply: recipe rename moves the brand-named module so rewritten requires resolve", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const dockerfileBefore = await read(copy, "Dockerfile");
    const fromLinesBefore = dockerfileBefore
      .split("\n")
      .filter((line) => /^\s*FROM\s/i.test(line));
    const licenseHash = sha256(await read(copy, "LICENSE"));

    const { code, payload, errors } = await applyJson(copy);
    assert.equal(code, 0, errors.join("\n"));

    // recipe auto-detected from package.json name (no --recipe flag)
    assert.ok(payload.recipe);
    assert.equal(payload.recipe.id, "pulse-status");
    assert.equal(payload.recipe.auto, true);

    // real filesystem rename happened, driven by the templated target
    assert.deepEqual(
      payload.renames.map((op) => [op.from, op.to, op.status]),
      [["server/pulse-status-server.js", "server/nova-demo-server.js", "renamed"]],
    );
    assert.equal(payload.totals.renamesPerformed, 1);
    assert.ok(await fileExists(path.join(copy, "server/nova-demo-server.js")));
    assert.equal(await fileExists(path.join(copy, "server/pulse-status-server.js")), false);

    // rewritten refs point at the renamed file and Node can resolve them
    assert.match(await read(copy, "server/index.js"), /require\("\.\/nova-demo-server"\)/);
    assert.match(await read(copy, "server/jobs.js"), /require\("\.\/nova-demo-server"\)/);
    const fromIndex = createRequire(path.join(copy, "server/index.js"));
    assert.ok(fromIndex.resolve("./nova-demo-server"), "require from index.js resolves");
    const fromJobs = createRequire(path.join(copy, "server/jobs.js"));
    assert.ok(fromJobs.resolve("./nova-demo-server"), "require from jobs.js resolves");
    for (const rel of ["server/nova-demo-server.js", "server/index.js", "server/jobs.js"]) {
      execFileSync(process.execPath, ["--check", path.join(copy, rel)], { encoding: "utf8" });
    }

    // Docker image refs are never rebranded
    const dockerfileAfter = await read(copy, "Dockerfile");
    const fromLinesAfter = dockerfileAfter.split("\n").filter((line) => /^\s*FROM\s/i.test(line));
    assert.deepEqual(fromLinesAfter, fromLinesBefore, "FROM lines must stay byte-identical");
    assert.match(dockerfileAfter, /FROM acme\/pulse-status:base-debian AS build/);
    assert.ok(!fromLinesAfter.some((line) => line.includes("nova-demo")));
    assert.ok(
      payload.skipped.some((entry) => entry.file === "Dockerfile" && /docker image ref/.test(entry.reason)),
      "docker FROM skip must be reported",
    );
    // compose: image: line preserved, service key renamed
    const composeAfter = await read(copy, "docker-compose.yml");
    assert.match(composeAfter, /image: acme\/pulse-status:latest/);
    assert.match(composeAfter, /^ {2}nova-demo:$/m);

    // license untouched
    assert.equal(sha256(await read(copy, "LICENSE")), licenseHash);
  });
});

test("apply: second run reports renames as already applied and changes nothing", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const first = await applyJson(copy);
    assert.equal(first.code, 0, first.errors.join("\n"));
    const afterFirst = await snapshot(copy);

    const second = await applyJson(copy);
    assert.equal(second.code, 0, second.errors.join("\n"));
    assert.deepEqual(second.payload.changed, []);
    assert.equal(second.payload.renames[0].status, "already");
    assert.equal(second.payload.renames[0].written, false);
    assert.equal(second.payload.totals.renamesPerformed, 0);
    assert.deepEqual(await snapshot(copy), afterFirst, "second apply must be a no-op");
  });
});

test("apply --dry-run: plans renames, moves nothing, writes nothing", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const before = await snapshot(copy);

    const { code, payload, errors } = await applyJson(copy, ["--dry-run"]);
    assert.equal(code, 0, errors.join("\n"));
    assert.equal(payload.dryRun, true);
    assert.equal(payload.renames[0].status, "would-rename");
    assert.equal(payload.renames[0].written, false);
    assert.ok(await fileExists(path.join(copy, "server/pulse-status-server.js")), "source stays in dry-run");
    assert.equal(await fileExists(path.join(copy, "server/nova-demo-server.js")), false);
    assert.deepEqual(await snapshot(copy), before, "dry-run must not change any file");
    assert.equal(await fileExists(path.join(copy, "docker-compose.relabel.yml")), false);
  });
});

test("apply: missing rename source is a non-fatal warning, not a crash", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary(
    recipeYaml({
      renames: [
        ["server/pulse-status-server.js", "server/{{slug}}-server.js"],
        ["server/does-not-exist.js", "server/{{slug}}-ghost.js"],
      ],
    }),
  );
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const { code, payload, errors } = await applyJson(copy);
    assert.equal(code, 0, errors.join("\n"));
    const ghost = payload.renames.find((op) => op.from === "server/does-not-exist.js");
    assert.ok(ghost);
    assert.equal(ghost.status, "missing");
    assert.equal(ghost.written, false);
    assert.ok(
      payload.warnings.some((warning) => /rename source missing: server\/does-not-exist\.js/.test(warning)),
      `missing warning reported, got: ${JSON.stringify(payload.warnings)}`,
    );
    // string patching still happened
    assert.ok(payload.changed.some((entry) => entry.file === "server/index.js"));
  });
});

test("apply: a recipe files: rule is the only way to rebrand docker image lines", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary(recipeYaml({ files: ["Dockerfile"] }));
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const { code, errors } = await applyJson(copy);
    assert.equal(code, 0, errors.join("\n"));
    const dockerfile = await read(copy, "Dockerfile");
    assert.match(dockerfile, /FROM acme\/nova-demo:base-debian AS build/, "files rule opts FROM line back in");
    assert.ok(!dockerfile.includes("FROM acme/pulse-status"));
    // compose has no files rule -> image ref still preserved
    assert.match(await read(copy, "docker-compose.yml"), /image: acme\/pulse-status:latest/);
  });
});

test("apply: CLI --recipe <id> selects the recipe explicitly", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const out = execFileSync(
      process.execPath,
      [CLI, "apply", copy, "--brand", "brand.yaml", "--recipe", "pulse-status", "--json"],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, RELABELD_RECIPES_DIR: library } },
    );
    const payload = JSON.parse(out) as ApplyPayload;
    assert.equal(payload.recipe?.id, "pulse-status");
    assert.equal(payload.recipe?.auto, false);
    assert.equal(payload.renames[0].status, "renamed");
    assert.ok(await fileExists(path.join(copy, "server/nova-demo-server.js")));

    let status = 0;
    try {
      execFileSync(process.execPath, [CLI, "apply", copy, "--recipe", "no-such-recipe"], {
        encoding: "utf8",
        cwd: ROOT,
        stdio: "pipe",
        env: { ...process.env, RELABELD_RECIPES_DIR: library },
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
    }
    assert.equal(status, 1, "unknown explicit recipe exits 1");
  });
});

/* ------------------------------------------------------------------ */
/* task-10: B4 dangling-ref guard + M6 compose command                */
/* ------------------------------------------------------------------ */

test("apply: B4 — without a matching recipe, dangling module refs stop the write (exit 1)", async () => {
  const copy = await moduleWorkspace();
  const emptyLibrary = await mkdtemp(path.join(tmpdir(), "relabel-empty-lib-"));
  tempDirs.push(emptyLibrary);
  await withRecipeLibrary(emptyLibrary, async () => {
    await initWithBrand(copy);
    const before = await snapshot(copy);

    const { ctx, errors } = makeCtx(ROOT);
    const code = await applyRun([copy, "--brand", "brand.yaml"], ctx);
    assert.equal(code, 1, "must refuse to write a tree with broken module refs");
    const stderr = errors.join("\n");
    assert.match(stderr, /refusing to write/i);
    assert.match(stderr, /server\/index\.js:\.\/nova-demo-server/);
    assert.match(stderr, /server\/jobs\.js:\.\/nova-demo-server/);
    assert.match(stderr, /nothing was written/i);

    // nothing was written and the old module was NOT renamed
    assert.deepEqual(await snapshot(copy), before);
    assert.ok(await fileExists(path.join(copy, "server/pulse-status-server.js")));
    assert.equal(await fileExists(path.join(copy, "server/nova-demo-server.js")), false);
    assert.match(await read(copy, "server/index.js"), /require\("\.\/pulse-status-server"\)/);
    assert.equal(await fileExists(path.join(copy, "docker-compose.relabel.yml")), false);

    // dry-run hits the same guard (reported, still no writes)
    const dry = makeCtx(ROOT);
    assert.equal(await applyRun([copy, "--brand", "brand.yaml", "--dry-run"], dry.ctx), 1);
    assert.match(dry.errors.join("\n"), /server\/index\.js:\.\/nova-demo-server/);
    assert.deepEqual(await snapshot(copy), before);
  });
});

test("apply: B4 — with the recipe rename the same repo passes and refs resolve", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);
    const first = await applyJson(copy);
    assert.equal(first.code, 0, first.errors.join("\n"));
    assert.equal(first.payload.renames[0].status, "renamed");
    const fromIndex = createRequire(path.join(copy, "server/index.js"));
    assert.ok(fromIndex.resolve("./nova-demo-server"));

    const afterFirst = await snapshot(copy);
    const second = await applyJson(copy);
    assert.equal(second.code, 0);
    assert.deepEqual(second.payload.changed, []);
    assert.equal(second.payload.renames[0].status, "already");
    assert.deepEqual(await snapshot(copy), afterFirst);
  });
});

test("apply: M6 — printed compose command includes the base compose file", async () => {
  const copy = await moduleWorkspace();
  const library = await recipeLibrary();
  await withRecipeLibrary(library, async () => {
    await initWithBrand(copy);

    const { ctx, errors, logs } = makeCtx(ROOT);
    assert.equal(await applyRun([copy, "--brand", "brand.yaml"], ctx), 0, errors.join("\n"));
    const human = logs.join("\n");
    assert.match(
      human,
      /docker compose -f docker-compose\.yml -f docker-compose\.relabel\.yml up -d/,
      `compose command must include the base file, got:\n${human}`,
    );
    assert.ok(!/@docker compose -f docker-compose\.relabel\.yml up -d/.test(human), "overlay-only command is wrong");

    // JSON exposes the same base + overlay pair
    const payload = (await applyJson(copy)).payload;
    assert.equal(payload.compose?.base, "docker-compose.yml");
    assert.equal(payload.compose?.file, "docker-compose.relabel.yml");
  });
});
