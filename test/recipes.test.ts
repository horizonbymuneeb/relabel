import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { recipesRoot, run as recipesRun, validateRecipe } from "../dist/recipes.js";
import type { Ctx, Recipe } from "../dist/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "dist/cli.js");

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "relabel-recipes-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

async function loadRecipeYaml(id: string): Promise<unknown> {
  return YAML.parse(await readFile(path.join(recipesRoot(), id, "recipe.yaml"), "utf8"));
}

const UPTIME_KUMA_SAMPLE = [
  "id: demo-recipe",
  "name: Demo Recipe",
  "upstream: https://example.com/demo",
  "match:",
  "  - index.html",
  "strings:",
  "  - Demo Brand",
  "assets:",
  "  - kind: logo",
  "    targets:",
  "      - public/logo.svg",
].join("\n");

test("recipes: both checked-in recipes validate against the Recipe contract", async () => {
  const root = recipesRoot();
  assert.equal(path.basename(root), "recipes");
  for (const id of ["uptime-kuma", "brightbean"]) {
    const parsed = await loadRecipeYaml(id);
    const { recipe, errors } = validateRecipe(parsed);
    assert.deepEqual(errors, [], `${id} must be valid`);
    assert.ok(recipe);
    assert.equal(recipe.id, id);
    assert.ok(recipe.name.length > 0);
    assert.ok(recipe.upstream.startsWith("https://"));
    assert.ok(recipe.strings.length > 0);
    assert.ok(recipe.match.length > 0);
    assert.ok(recipe.assets.length > 0);
    for (const asset of recipe.assets) {
      assert.ok(["logo", "favicon", "og-image"].includes(asset.kind));
      assert.ok(asset.targets.length > 0);
    }
  }
});

test("recipes: uptime-kuma matches the real louislam/uptime-kuma layout", async () => {
  const { recipe } = validateRecipe(await loadRecipeYaml("uptime-kuma"));
  assert.ok(recipe);
  assert.equal(recipe.name, "Uptime Kuma");
  assert.match(recipe.upstream, /louislam\/uptime-kuma/);
  assert.ok(recipe.strings.includes("Uptime Kuma"));
  assert.ok(recipe.strings.includes("Uptime-Kuma"));
  assert.ok(recipe.strings.includes("uptime-kuma"));

  const logo = recipe.assets.find((asset) => asset.kind === "logo");
  assert.deepEqual(logo?.targets, ["public/icon.svg"]);
  const favicon = recipe.assets.find((asset) => asset.kind === "favicon");
  assert.deepEqual(favicon?.targets, ["public/favicon.ico"]);

  assert.equal(recipe.compose?.service, "uptime-kuma");
  assert.equal(recipe.compose?.port, 3001);
  assert.equal(recipe.verify?.url, "http://localhost:3001");
  assert.match(recipe.match.join(" "), /package\.json/);
  assert.ok((recipe.notes ?? []).some((note) => /LICENSE/i.test(note)));
});

test("recipes: brightbean matches the /srv/brightbean surface", async () => {
  const { recipe } = validateRecipe(await loadRecipeYaml("brightbean"));
  assert.ok(recipe);
  assert.equal(recipe.name, "BrightBean Studio");
  assert.match(recipe.upstream, /brightbeanxyz\/brightbean-studio/);
  for (const brand of ["BrightBean Studio", "BrightBean", "Brightbean", "brightbean"]) {
    assert.ok(recipe.strings.includes(brand), `strings missing ${brand}`);
  }
  for (const surface of ["config/settings/", "templates/", "static/"]) {
    assert.ok(recipe.match.includes(surface), `match missing ${surface}`);
  }
  const logoTargets = recipe.assets.find((asset) => asset.kind === "logo")?.targets ?? [];
  assert.ok(logoTargets.includes("static/img/nova-logo.svg"));
  const faviconTargets = recipe.assets.find((asset) => asset.kind === "favicon")?.targets ?? [];
  assert.ok(faviconTargets.some((target) => target === "static/favicon/favicon.ico"));
  assert.equal(recipe.compose?.service, "app");
  assert.equal(recipe.compose?.port, 8000);
  assert.equal(recipe.compose?.base, "compose.selfhost.yaml");
  assert.ok((recipe.notes ?? []).some((note) => /AGPL/.test(note)));
});

test("recipe list: human and JSON modes", async () => {
  const json = await captureStdout(() => recipesRun(["list", "--json"], makeCtx(ROOT, true).ctx));
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.out) as { count: number; recipes: Recipe[] };
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.recipes.map((recipe) => recipe.id).sort(), ["brightbean", "uptime-kuma"]);

  const humanCtx = makeCtx(ROOT);
  assert.equal(await recipesRun(["list"], humanCtx.ctx), 0);
  const human = humanCtx.logs.join("\n");
  assert.match(human, /uptime-kuma/);
  assert.match(human, /brightbean/);
});

test("recipe show: JSON, human, and error exit codes", async () => {
  const json = await captureStdout(() =>
    recipesRun(["show", "uptime-kuma", "--json"], makeCtx(ROOT, true).ctx),
  );
  assert.equal(json.code, 0);
  const recipe = JSON.parse(json.out) as Recipe;
  assert.equal(recipe.id, "uptime-kuma");

  const humanCtx = makeCtx(ROOT);
  assert.equal(await recipesRun(["show", "uptime-kuma"], humanCtx.ctx), 0);
  const human = humanCtx.logs.join("\n");
  assert.match(human, /Uptime Kuma \(uptime-kuma\)/);
  assert.match(human, /public\/icon\.svg/);

  const missing = makeCtx(ROOT);
  assert.equal(await recipesRun(["show", "nope"], missing.ctx), 1);
  assert.match(missing.errors.join(" "), /no such recipe/);

  const badId = makeCtx(ROOT);
  assert.equal(await recipesRun(["show", "Bad_ID"], badId.ctx), 2);

  assert.equal(await recipesRun([], makeCtx(ROOT).ctx), 2);
  assert.equal(await recipesRun(["bogus"], makeCtx(ROOT).ctx), 2);
});

test("recipe add: installs, refuses overwrite, --force replaces", async () => {
  const library = await tempDir("relabel-library-");
  const source = await tempDir("relabel-source-");
  await writeFile(path.join(source, "recipe.yaml"), UPTIME_KUMA_SAMPLE, "utf8");
  const previous = process.env.RELABELD_RECIPES_DIR;
  process.env.RELABELD_RECIPES_DIR = library;
  try {
    assert.equal(recipesRoot(), library);
    const added = await captureStdout(() => recipesRun(["add", source, "--json"], makeCtx(ROOT, true).ctx));
    assert.equal(added.code, 0);
    const payload = JSON.parse(added.out) as { added: string; name: string; path: string };
    assert.equal(payload.added, "demo-recipe");
    assert.equal(payload.name, "Demo Recipe");

    const installed = await readFile(path.join(library, "demo-recipe", "recipe.yaml"), "utf8");
    assert.equal(installed, UPTIME_KUMA_SAMPLE);

    const again = makeCtx(ROOT);
    assert.equal(await recipesRun(["add", source], again.ctx), 1);
    assert.match(again.errors.join(" "), /already installed/);
    assert.equal(await recipesRun(["add", source, "--force"], makeCtx(ROOT).ctx), 0);

    const list = await captureStdout(() => recipesRun(["list", "--json"], makeCtx(ROOT, true).ctx));
    const listed = JSON.parse(list.out) as { count: number; recipes: Recipe[] };
    assert.equal(listed.count, 1);
    assert.equal(listed.recipes[0].id, "demo-recipe");

    const broken = await tempDir("relabel-broken-");
    await writeFile(path.join(broken, "recipe.yaml"), "id: broken\nname: ''\n", "utf8");
    const bad = makeCtx(ROOT);
    assert.equal(await recipesRun(["add", broken], bad.ctx), 1);
    assert.match(bad.errors.join(" "), /upstream is required/);
  } finally {
    if (previous === undefined) delete process.env.RELABELD_RECIPES_DIR;
    else process.env.RELABELD_RECIPES_DIR = previous;
  }
});

test("cli: recipe list/show work through the real CLI", () => {
  const list = execFileSync(process.execPath, [CLI, "recipe", "list", "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  const payload = JSON.parse(list) as { count: number };
  assert.ok(payload.count >= 2);

  const show = execFileSync(process.execPath, [CLI, "recipe", "show", "uptime-kuma", "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal((JSON.parse(show) as Recipe).id, "uptime-kuma");

  const human = execFileSync(process.execPath, [CLI, "recipe", "list"], { encoding: "utf8", cwd: ROOT });
  assert.match(human, /BrightBean Studio/);
  assert.match(human, /Uptime Kuma/);

  let status = 0;
  try {
    execFileSync(process.execPath, [CLI, "recipe", "show", "not-a-recipe"], { encoding: "utf8", cwd: ROOT });
  } catch (error) {
    status = (error as { status?: number }).status ?? -1;
  }
  assert.equal(status, 1);
});


/* ------------------------------------------------------------------ */
/* task-15: renames[] validation (docs promise)                       */
/* ------------------------------------------------------------------ */

const VALID_RECIPE_BASE = {
  id: "demo-recipe",
  name: "Demo Recipe",
  upstream: "https://example.com/demo",
  match: ["package.json"],
  strings: ["Demo Brand"],
  assets: [],
};

test("recipes: renames validation rejects malformed entries and unsafe paths", () => {
  const notArray = validateRecipe({ ...VALID_RECIPE_BASE, renames: "nope" });
  assert.ok(notArray.errors.some((error) => /renames must be an array/.test(error)), notArray.errors.join("; "));

  const missingTo = validateRecipe({ ...VALID_RECIPE_BASE, renames: [{ from: "server/a.js" }] });
  assert.ok(
    missingTo.errors.some((error) => /renames\[0\]\.to must be a non-empty string/.test(error)),
    missingTo.errors.join("; "),
  );

  const badEntry = validateRecipe({ ...VALID_RECIPE_BASE, renames: ["server/a.js"] });
  assert.ok(
    badEntry.errors.some((error) => /renames\[0\] must be a mapping/.test(error)),
    badEntry.errors.join("; "),
  );

  const absolute = validateRecipe({ ...VALID_RECIPE_BASE, renames: [{ from: "/etc/passwd", to: "x/y" }] });
  assert.ok(
    absolute.errors.some((error) => /renames\[0\]\.from must be a safe repo-relative path/.test(error)),
    absolute.errors.join("; "),
  );

  const escape = validateRecipe({ ...VALID_RECIPE_BASE, renames: [{ from: "server/../../escape.js", to: "x/y" }] });
  assert.ok(
    escape.errors.some((error) => /renames\[0\]\.from must be a safe repo-relative path/.test(error)),
    escape.errors.join("; "),
  );

  const badTo = validateRecipe({ ...VALID_RECIPE_BASE, renames: [{ from: "server/a.js", to: "../escape" }] });
  assert.ok(
    badTo.errors.some((error) => /renames\[0\]\.to must be a safe repo-relative path/.test(error)),
    badTo.errors.join("; "),
  );

  const ok = validateRecipe({
    ...VALID_RECIPE_BASE,
    renames: [{ from: "server/a.js", to: "server/{{slug}}-server.js" }],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.recipe?.renames?.length, 1);
});

test("recipes: recipe add rejects a recipe with invalid renames", async () => {
  const library = await tempDir("relabel-library-renames-");
  const source = await tempDir("relabel-source-renames-");
  const invalid = [
    ...UPTIME_KUMA_SAMPLE.split("\n"),
    "renames:",
    '  - from: "/etc/passwd"',
    '    to: "../outside.js"',
  ].join("\n");
  await writeFile(path.join(source, "recipe.yaml"), invalid, "utf8");
  const previous = process.env.RELABELD_RECIPES_DIR;
  process.env.RELABELD_RECIPES_DIR = library;
  try {
    const ctx = makeCtx(ROOT);
    assert.equal(await recipesRun(["add", source], ctx.ctx), 1);
    const errors = ctx.errors.join("\n");
    assert.match(errors, /renames\[0\]\.from must be a safe repo-relative path/);
    assert.match(errors, /renames\[0\]\.to must be a safe repo-relative path/);
  } finally {
    if (previous === undefined) delete process.env.RELABELD_RECIPES_DIR;
    else process.env.RELABELD_RECIPES_DIR = previous;
  }
});
