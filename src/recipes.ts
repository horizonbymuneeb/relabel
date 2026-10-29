/**
 * relabeld recipe — list / show / add per-app recipes.
 *
 * A recipe is `recipes/<id>/recipe.yaml` validated against the Recipe type.
 * RELABELD_RECIPES_DIR overrides the recipe root (used by tests).
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx, Recipe } from "./types.js";
import { exists, loadYamlFile, relPosix, toPosix } from "./util.js";

export const RECIPE_USAGE = [
  "Usage: relabeld recipe <list|show <id>|add <path>> [--json]",
  "",
  "  list        list installed recipes",
  "  show <id>   print one recipe (validated)",
  "  add <path>  copy a recipe directory/file into the recipe library",
  "",
  "  --json      machine-readable output",
  "  --force     overwrite an existing recipe on add",
].join("\n");

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Recipe library root: dist/../recipes, overridable for tests. */
export function recipesRoot(): string {
  return process.env.RELABELD_RECIPES_DIR ?? path.resolve(HERE, "..", "recipes");
}

const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ASSET_KINDS = new Set(["logo", "favicon", "og-image"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** True for a safe repo-relative recipe path (no absolute paths / .. escapes). */
export function isSafeRecipePath(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) return false;
  if (raw.includes("\u0000")) return false;
  const segments = raw.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return true;
}

/** Structural validation against the Recipe contract. */
export function validateRecipe(data: unknown): { recipe: Recipe | null; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") return { recipe: null, errors: ["recipe is not a mapping"] };
  const raw = data as Record<string, unknown>;
  const push = (message: string): void => {
    errors.push(message);
  };

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) push("id is required");
  else if (!RECIPE_ID_RE.test(id)) push(`id "${id}" must be kebab-case (a-z0-9-)`);

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) push("name is required");

  const upstream = typeof raw.upstream === "string" ? raw.upstream.trim() : "";
  if (!upstream) push("upstream is required");
  else if (!/^https?:\/\//.test(upstream)) push("upstream must be an http(s) URL");

  if (!isStringArray(raw.match)) push("match must be an array of strings");

  if (!isStringArray(raw.strings) || (raw.strings as string[]).length === 0) {
    push("strings must be a non-empty array of brand strings");
  }

  if (!Array.isArray(raw.assets)) {
    push("assets must be an array");
  } else {
    (raw.assets as unknown[]).forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        push(`assets[${index}] must be a mapping`);
        return;
      }
      const asset = entry as Record<string, unknown>;
      if (typeof asset.kind !== "string" || !ASSET_KINDS.has(asset.kind)) {
        push(`assets[${index}].kind must be logo|favicon|og-image`);
      }
      if (!isStringArray(asset.targets) || (asset.targets as string[]).length === 0) {
        push(`assets[${index}].targets must be a non-empty array of paths`);
      }
    });
  }

  if (raw.renames !== undefined) {
    if (!Array.isArray(raw.renames)) {
      push("renames must be an array of {from,to}");
    } else {
      (raw.renames as unknown[]).forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
          push(`renames[${index}] must be a mapping with from/to`);
          return;
        }
        const item = entry as Record<string, unknown>;
        const from = typeof item.from === "string" ? item.from.trim() : "";
        const to = typeof item.to === "string" ? item.to.trim() : "";
        if (!from) push(`renames[${index}].from must be a non-empty string`);
        else if (!isSafeRecipePath(from)) push(`renames[${index}].from must be a safe repo-relative path`);
        if (!to) push(`renames[${index}].to must be a non-empty string`);
        else if (!isSafeRecipePath(to)) push(`renames[${index}].to must be a safe repo-relative path`);
      });
    }
  }

  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env)) push("env must be an array");
    else {
      (raw.env as unknown[]).forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
          push(`env[${index}] must be a mapping`);
          return;
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.name !== "string" || !item.name) push(`env[${index}].name is required`);
        if (typeof item.value !== "string") push(`env[${index}].value must be a string`);
      });
    }
  }

  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) push("files must be an array");
    else {
      (raw.files as unknown[]).forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
          push(`files[${index}] must be a mapping`);
          return;
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.path !== "string" || !item.path) push(`files[${index}].path is required`);
        if (!Array.isArray(item.replace)) push(`files[${index}].replace must be an array`);
      });
    }
  }

  if (raw.compose !== undefined) {
    if (!raw.compose || typeof raw.compose !== "object") push("compose must be a mapping");
    else {
      const compose = raw.compose as Record<string, unknown>;
      if (compose.service !== undefined && typeof compose.service !== "string") {
        push("compose.service must be a string");
      }
      if (compose.port !== undefined && typeof compose.port !== "number") {
        push("compose.port must be a number");
      }
    }
  }

  if (raw.verify !== undefined) {
    if (!raw.verify || typeof raw.verify !== "object") push("verify must be a mapping");
    else {
      const verify = raw.verify as Record<string, unknown>;
      if (verify.url !== undefined && typeof verify.url !== "string") push("verify.url must be a string");
      if (verify.paths !== undefined && !isStringArray(verify.paths)) push("verify.paths must be a string array");
    }
  }

  if (raw.notes !== undefined && !isStringArray(raw.notes)) push("notes must be a string array");

  if (errors.length) return { recipe: null, errors };
  return { recipe: raw as unknown as Recipe, errors };
}

interface RecipeEntry {
  id: string;
  dir: string;
  file: string;
}

async function listRecipeEntries(): Promise<RecipeEntry[]> {
  const root = recipesRoot();
  if (!exists(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: RecipeEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "recipe.yaml");
    if (exists(file)) out.push({ id: entry.name, dir: path.join(root, entry.name), file });
  }
  return out;
}

async function loadRecipeFrom(file: string): Promise<{ recipe: Recipe | null; errors: string[] }> {
  let data: unknown;
  try {
    data = await loadYamlFile<unknown>(file);
  } catch (error) {
    return { recipe: null, errors: [`cannot parse ${file}: ${(error as Error).message}`] };
  }
  return validateRecipe(data);
}

function recipeSummary(recipe: Recipe): Record<string, unknown> {
  return {
    id: recipe.id,
    name: recipe.name,
    upstream: recipe.upstream,
    strings: recipe.strings,
    renames: recipe.renames ?? [],
    assets: recipe.assets,
    compose: recipe.compose ?? null,
    verify: recipe.verify ?? null,
  };
}

function humanRecipe(recipe: Recipe): string[] {
  const lines: string[] = [];
  lines.push(`${recipe.name} (${recipe.id})`);
  lines.push(`  upstream  ${recipe.upstream}`);
  if (recipe.docs) lines.push(`  docs      ${recipe.docs}`);
  lines.push(`  match     ${recipe.match.join(", ") || "—"}`);
  lines.push(`  strings   ${recipe.strings.join(", ")}`);
  if (recipe.assets.length) {
    lines.push("  assets");
    for (const asset of recipe.assets) {
      lines.push(`    ${asset.kind.padEnd(8)} → ${asset.targets.join(", ")}`);
    }
  }
  if (recipe.renames?.length) {
    lines.push("  renames");
    for (const rename of recipe.renames) lines.push(`    ${rename.from} → ${rename.to}`);
  }
  if (recipe.env?.length) {
    lines.push(`  env       ${recipe.env.map((entry) => entry.name).join(", ")}`);
  }
  if (recipe.files?.length) {
    lines.push(`  files     ${recipe.files.map((entry) => entry.path).join(", ")}`);
  }
  if (recipe.compose) {
    const parts = [
      recipe.compose.base ? `base ${recipe.compose.base}` : null,
      recipe.compose.service ? `service ${recipe.compose.service}` : null,
      recipe.compose.port ? `port ${recipe.compose.port}` : null,
    ].filter(Boolean);
    lines.push(`  compose   ${parts.join(", ")}`);
  }
  if (recipe.verify) {
    const paths = recipe.verify.paths?.length ? ` paths ${recipe.verify.paths.join(", ")}` : "";
    lines.push(`  verify    ${recipe.verify.url ?? "—"}${paths}`);
  }
  if (recipe.notes?.length) {
    lines.push("  notes");
    for (const note of recipe.notes) lines.push(`    - ${note}`);
  }
  return lines;
}

async function commandList(ctx: Ctx): Promise<number> {
  const entries = await listRecipeEntries();
  const recipes: Recipe[] = [];
  const invalid: Array<{ id: string; errors: string[] }> = [];
  for (const entry of entries) {
    const { recipe, errors } = await loadRecipeFrom(entry.file);
    if (recipe) recipes.push(recipe);
    else invalid.push({ id: entry.id, errors });
  }
  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          root: toPosix(recipesRoot()),
          count: recipes.length,
          recipes: recipes.map((recipe) => recipeSummary(recipe)),
          ...(invalid.length ? { invalid } : {}),
        },
        null,
        2,
      ),
    );
    return invalid.length ? 1 : 0;
  }
  ctx.log(`recipes (${recipes.length}) — ${toPosix(recipesRoot())}`);
  if (recipes.length === 0) ctx.log("  none installed");
  const idWidth = Math.max(4, ...recipes.map((recipe) => recipe.id.length));
  for (const recipe of recipes) {
    ctx.log(`  ${recipe.id.padEnd(idWidth)}  ${recipe.name.padEnd(24)}  ${recipe.upstream}`);
  }
  if (invalid.length) {
    ctx.log("");
    for (const entry of invalid) {
      ctx.log(`invalid recipe ${entry.id}: ${entry.errors.join("; ")}`);
    }
  }
  return invalid.length ? 1 : 0;
}

async function commandShow(id: string, ctx: Ctx): Promise<number> {
  const root = recipesRoot();
  if (!RECIPE_ID_RE.test(id)) {
    ctx.error(`recipe: invalid id "${id}" (kebab-case expected)`);
    return 2;
  }
  const file = path.join(root, id, "recipe.yaml");
  if (!exists(file)) {
    ctx.error(`recipe: no such recipe: ${id}`);
    return 1;
  }
  const { recipe, errors } = await loadRecipeFrom(file);
  if (!recipe) {
    for (const error of errors) ctx.error(`recipe ${id}: ${error}`);
    return 1;
  }
  if (recipe.id !== id) {
    ctx.error(`recipe ${id}: id mismatch (recipe says "${recipe.id}")`);
    return 1;
  }
  if (ctx.json) {
    console.log(JSON.stringify(recipe, null, 2));
    return 0;
  }
  for (const line of humanRecipe(recipe)) ctx.log(line);
  return 0;
}

async function commandAdd(rawPath: string, force: boolean, ctx: Ctx): Promise<number> {
  const source = path.resolve(ctx.cwd, rawPath);
  let info;
  try {
    info = await stat(source);
  } catch {
    ctx.error(`recipe: no such path: ${source}`);
    return 1;
  }
  const sourceFile = info.isDirectory() ? path.join(source, "recipe.yaml") : source;
  if (!exists(sourceFile)) {
    ctx.error(`recipe: no recipe.yaml at ${sourceFile}`);
    return 1;
  }
  const { recipe, errors } = await loadRecipeFrom(sourceFile);
  if (!recipe) {
    for (const error of errors) ctx.error(`recipe ${toPosix(sourceFile)}: ${error}`);
    return 1;
  }
  const root = recipesRoot();
  const targetDir = path.join(root, recipe.id);
  if (exists(targetDir) && !force) {
    ctx.error(`recipe: ${recipe.id} already installed at ${toPosix(targetDir)} (use --force)`);
    return 1;
  }
  await mkdir(root, { recursive: true });
  if (exists(targetDir)) {
    const { rm } = await import("node:fs/promises");
    await rm(targetDir, { recursive: true, force: true });
  }
  if (info.isDirectory()) {
    await cp(source, targetDir, { recursive: true });
  } else {
    await mkdir(targetDir, { recursive: true });
    await cp(sourceFile, path.join(targetDir, "recipe.yaml"));
  }
  const installed = relPosix(root, path.join(targetDir, "recipe.yaml"));
  if (ctx.json) {
    console.log(
      JSON.stringify({ added: recipe.id, name: recipe.name, path: toPosix(targetDir), recipeFile: toPosix(installed) }, null, 2),
    );
    return 0;
  }
  ctx.log(`added recipe ${recipe.id} (${recipe.name}) → ${toPosix(targetDir)}`);
  return 0;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.add("json");
    else if (arg === "--force") flags.add("force");
    else if (arg === "--help" || arg === "-h") flags.add("help");
    else if (arg === "--cwd") i++; // global option, already handled by cli.ts
    else if (arg.startsWith("--")) {
      ctx.error(`recipe: unknown option: ${arg}`);
      ctx.error(RECIPE_USAGE);
      return 2;
    } else positionals.push(arg);
  }
  if (flags.has("help")) {
    ctx.log(RECIPE_USAGE);
    return 0;
  }
  const sub = positionals[0];
  if (!sub) {
    ctx.error("recipe: missing subcommand (list|show|add)");
    ctx.error(RECIPE_USAGE);
    return 2;
  }
  switch (sub) {
    case "list": {
      if (positionals.length > 1) {
        ctx.error("recipe: list takes no arguments");
        return 2;
      }
      return commandList(ctx);
    }
    case "show": {
      const id = positionals[1];
      if (!id) {
        ctx.error("recipe: show requires an id");
        ctx.error(RECIPE_USAGE);
        return 2;
      }
      if (positionals.length > 2) {
        ctx.error("recipe: show takes exactly one id");
        return 2;
      }
      return commandShow(id, ctx);
    }
    case "add": {
      const target = positionals[1];
      if (!target) {
        ctx.error("recipe: add requires a path");
        ctx.error(RECIPE_USAGE);
        return 2;
      }
      if (positionals.length > 2) {
        ctx.error("recipe: add takes exactly one path");
        return 2;
      }
      return commandAdd(target, flags.has("force"), ctx);
    }
    default:
      ctx.error(`recipe: unknown subcommand: ${sub}`);
      ctx.error(RECIPE_USAGE);
      return 2;
  }
}
