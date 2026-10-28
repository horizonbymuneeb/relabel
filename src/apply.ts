/**
 * relabeld apply — patch brand strings/assets/compose from brand.yaml.
 *
 * Guarantees:
 *  - word-boundary, case-preserving replacements (PULSE-STATUS -> NOVA-DEMO,
 *    Pulse-Status -> Nova-Demo, pulse-status -> nova-demo)
 *  - recipe-driven file renames run after the text patch, so rewritten
 *    require()/import refs resolve (idempotent: an already-renamed file is
 *    reported, never renamed twice)
 *  - docker image references (Dockerfile `FROM ...`, compose `image: ...`)
 *    are never rewritten, unless a recipe `files:` rule explicitly targets
 *    that file
 *  - license files and copyright/license lines are never rewritten
 *  - brand.keep entries are never rewritten
 *  - --dry-run performs no writes (no text, no asset copy, no rename)
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AssetHit, BrandSpec, Ctx, Recipe, RecipeRename } from "./types.js";
import {
  escapeRegExp,
  exists,
  loadYamlFile,
  readTextIfSmall,
  relPosix,
  slugify,
  toPosix,
} from "./util.js";
import {
  flagErrors,
  flagString,
  isBrandSpecFile,
  isLicenseLine,
  isLicensePath,
  isScannableText,
  parseToolArgs,
  scanAssets,
  variantsFor,
  walkRepo,
} from "./scan.js";
import { recipesRoot } from "./recipes.js";

export const APPLY_USAGE = [
  "Usage: relabeld apply [dir] [--brand brand.yaml] [--recipe <id|path>] [--dry-run] [--json]",
  "",
  "Patch brand strings, assets, recipe renames and a compose override from brand.yaml.",
  "",
  "  --brand <path>   brand spec (default: brand.yaml in <dir>)",
  "  --recipe <id>    recipe to use (id in the recipe library or a path to recipe.yaml);",
  "                   auto-detected from package.json/dirname when omitted",
  "  --dry-run        report changes, write nothing",
  "  --json           machine-readable {changed,skipped,renames}",
].join("\n");

const COMPOSE_BASENAME_RE = /^(docker[-_.]?)?compose([.\w-]*)?\.ya?ml$/i;
const COMPOSE_PREFERENCE = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "compose.yml",
];
const GENERATED_COMPOSE = "docker-compose.relabel.yml";
const DOCKER_FROM_RE = /^\s*FROM\s/i;
const DOCKER_IMAGE_RE = /^\s*image:\s/i;
const DOCKERFILE_BASENAME_RE = /^(dockerfile|containerfile)(\.[\w.-]+)?$/i;
const MANIFEST_EXT_RE = /\.(ya?ml|json)$/i;

interface ReplaceRule {
  variant: string;
  base: string;
  re: RegExp;
}

interface Change {
  file: string;
  replacements: number;
}

interface Skip {
  file: string;
  reason: string;
  lines?: number;
}

interface AssetOp {
  kind: AssetHit["kind"];
  from: string;
  file: string;
  bytes: number;
  written: boolean;
}

interface ComposeOp {
  file: string;
  service: string;
  newService: string;
  written: boolean;
}

type RenameStatus = "renamed" | "would-rename" | "already" | "missing" | "conflict" | "skipped";

interface RenameOp {
  from: string;
  to: string;
  status: RenameStatus;
  written: boolean;
}

/** Recipe data apply actually needs (id/name + renames + files opt-ins). */
interface ApplyRecipe {
  id: string;
  name: string;
  source: string;
  auto: boolean;
  renames: RecipeRename[];
  filePaths: string[];
}

/* ------------------------------------------------------------------ */
/* replacement shaping                                                */
/* ------------------------------------------------------------------ */

/** Shape the new brand name the same way the old token was shaped. */
export function replacementBase(variant: string, name: string): string {
  const newWords = name.trim().split(/\s+/).filter(Boolean);
  const separator = /[_\- ]/.exec(variant)?.[0] ?? "";
  if (separator) return newWords.join(separator);
  // single token without separator: keep one-word shape
  const camel = /[a-z][A-Z]/.test(variant) || /^[A-Z][a-z0-9]*[A-Z]/.test(variant);
  if (camel) return newWords.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("");
  return newWords[0] ?? name;
}

function titleCase(value: string): string {
  return value
    .split(/([ _-]+)/)
    .map((segment, index) => {
      if (index % 2 === 1 || !segment) return segment;
      return segment[0].toUpperCase() + segment.slice(1);
    })
    .join("");
}

function isTitleLike(value: string): boolean {
  const words = value.split(/[ _-]+/).filter(Boolean);
  return words.length > 0 && words.every((word) => /^[A-Z][a-z0-9]*$/.test(word));
}

/** Preserve the source casing style when substituting the brand. */
export function applyCase(replacement: string, matched: string): string {
  const letters = matched.replace(/[^A-Za-z]/g, "");
  if (!letters) return replacement;
  if (letters === letters.toUpperCase()) return replacement.toUpperCase();
  if (letters === letters.toLowerCase()) return replacement.toLowerCase();
  if (isTitleLike(matched)) return titleCase(replacement);
  return replacement;
}

export function buildRules(variants: string[], name: string): ReplaceRule[] {
  const byLower = new Map<string, string>();
  for (const variant of variants) {
    for (const shape of variantsFor(variant)) {
      if (!byLower.has(shape.toLowerCase())) byLower.set(shape.toLowerCase(), shape);
    }
  }
  const rules: ReplaceRule[] = [];
  for (const shape of byLower.values()) {
    if (!shape) continue;
    rules.push({
      variant: shape,
      base: replacementBase(shape, name),
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(shape)}(?![A-Za-z0-9])`, "gi"),
    });
  }
  rules.sort((a, b) => b.variant.length - a.variant.length);
  return rules;
}

/** Single-pass, longest-match replacement on one line. */
export function replaceLine(line: string, rules: ReplaceRule[]): { text: string; count: number } {
  if (!line || rules.length === 0) return { text: line, count: 0 };
  const hits: Array<{ start: number; end: number; text: string; rule: ReplaceRule }> = [];
  for (const rule of rules) {
    const re = rule.re;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      hits.push({ start: match.index, end: match.index + match[0].length, text: match[0], rule });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  if (hits.length === 0) return { text: line, count: 0 };
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    out += line.slice(cursor, hit.start) + applyCase(hit.rule.base, hit.text);
    cursor = hit.end;
    count++;
  }
  out += line.slice(cursor);
  return { text: out, count };
}

/* ------------------------------------------------------------------ */
/* brand spec loading                                                 */
/* ------------------------------------------------------------------ */

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function validateBrand(data: unknown): { brand: BrandSpec | null; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") return { brand: null, errors: ["brand.yaml is not a mapping"] };
  const raw = data as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) errors.push("brand.yaml: name is required");
  const paletteRaw = raw.palette;
  const paletteObj = paletteRaw && typeof paletteRaw === "object" ? (paletteRaw as Record<string, unknown>) : {};
  const primary = typeof paletteObj.primary === "string" ? paletteObj.primary.trim() : "";
  if (!primary) errors.push("brand.yaml: palette.primary is required");
  if (raw.domain !== undefined && typeof raw.domain !== "string") errors.push("brand.yaml: domain must be a string");
  const variants = asStringArray(raw.variants);
  if (variants.length === 0) errors.push("brand.yaml: variants must contain at least one old brand string");
  const brand: BrandSpec = {
    name,
    palette: {
      primary,
      ...(typeof paletteObj.accent === "string" ? { accent: paletteObj.accent } : {}),
      ...(typeof paletteObj.background === "string" ? { background: paletteObj.background } : {}),
    },
    variants,
    keep: asStringArray(raw.keep),
  };
  if (typeof raw.domain === "string" && raw.domain.trim()) brand.domain = raw.domain.trim();
  if (typeof raw.emailFrom === "string") brand.emailFrom = raw.emailFrom;
  if (typeof raw.logo === "string") brand.logo = raw.logo;
  if (typeof raw.favicon === "string") brand.favicon = raw.favicon;
  return { brand: errors.length ? null : brand, errors };
}

async function resolveBrandPath(root: string, cwd: string, raw: string): Promise<string> {
  const candidates = [path.resolve(root, raw), path.resolve(cwd, raw)];
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  return candidates[0];
}

/* ------------------------------------------------------------------ */
/* recipe loading (renames + docker-line opt-in)                      */
/* ------------------------------------------------------------------ */

/** Brand placeholders usable inside recipe rename targets. */
export function renderBrandTemplate(template: string, brand: BrandSpec): string {
  const words = brand.name.trim().split(/\s+/).filter(Boolean);
  const pascal = words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("");
  const camel = words
    .map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join("");
  const slug = slugify(brand.name);
  return template
    .replace(/\{\{\s*slug\s*\}\}|\{\{\s*kebab\s*\}\}/g, slug)
    .replace(/\{\{\s*snake\s*\}\}/g, slug.replace(/-/g, "_"))
    .replace(/\{\{\s*pascal\s*\}\}/g, pascal)
    .replace(/\{\{\s*camel\s*\}\}/g, camel)
    .replace(/\{\{\s*name\s*\}\}/g, brand.name)
    .replace(/\{\{\s*lower\s*\}\}/g, brand.name.toLowerCase());
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** Extract the subset of a recipe that apply uses; invalid bits are warnings. */
export function parseApplyRecipe(
  data: unknown,
  source: string,
  auto: boolean,
  warnings: string[],
): ApplyRecipe | null {
  if (!isStringRecord(data)) {
    warnings.push(`recipe ignored (not a mapping): ${source}`);
    return null;
  }
  const id = typeof data.id === "string" ? data.id.trim() : "";
  const name = typeof data.name === "string" ? data.name.trim() : id;
  if (!id) warnings.push(`recipe ignored (no id): ${source}`);
  const renames: RecipeRename[] = [];
  if (data.renames !== undefined) {
    if (!Array.isArray(data.renames)) {
      warnings.push(`recipe renames ignored (not an array): ${source}`);
    } else {
      (data.renames as unknown[]).forEach((entry, index) => {
        if (!isStringRecord(entry) || typeof entry.from !== "string" || typeof entry.to !== "string") {
          warnings.push(`recipe rename[${index}] ignored (needs string from/to): ${source}`);
          return;
        }
        if (!entry.from || !entry.to) {
          warnings.push(`recipe rename[${index}] ignored (empty from/to): ${source}`);
          return;
        }
        renames.push({ from: entry.from, to: entry.to });
      });
    }
  }
  const filePaths: string[] = [];
  if (Array.isArray(data.files)) {
    for (const entry of data.files as unknown[]) {
      if (isStringRecord(entry) && typeof entry.path === "string" && entry.path) filePaths.push(entry.path);
    }
  }
  return { id, name, source, auto, renames, filePaths };
}

function matchPathsOf(data: unknown): string[] {
  if (!isStringRecord(data) || !Array.isArray(data.match)) return [];
  return (data.match as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function readPackageName(root: string): Promise<string> {
  try {
    const raw = await readTextIfSmall(path.join(root, "package.json"), 256 * 1024);
    if (!raw) return "";
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : "";
  } catch {
    return "";
  }
}

function repoLooksLike(root: string, matchPaths: string[]): boolean {
  if (matchPaths.length === 0) return true;
  const hits = matchPaths.filter((candidate) => exists(path.resolve(root, candidate.replace(/\/+$/, "")))).length;
  return hits / matchPaths.length >= 0.5;
}

/**
 * Auto-detect the recipe for a repo: package.json name / dirname match first,
 * then "already applied" evidence (a rendered rename target exists), so a
 * second `apply` still knows which renames are already done.
 */
async function detectRecipe(root: string, brand: BrandSpec): Promise<ApplyRecipe | null> {
  const libraryRoot = recipesRoot();
  if (!exists(libraryRoot)) return null;
  let entries;
  try {
    entries = await readdir(libraryRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const pkgName = await readPackageName(root);
  const dirName = path.basename(path.resolve(root));
  const nameMatches = (id: string): boolean =>
    Boolean(
      id &&
        (id === pkgName ||
          id === dirName ||
          pkgName.startsWith(`${id}-`) ||
          dirName.startsWith(`${id}-`)),
    );

  const candidates: Array<{ recipe: ApplyRecipe; matchPaths: string[]; score: number }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(libraryRoot, entry.name, "recipe.yaml");
    if (!exists(file)) continue;
    let data: unknown;
    try {
      data = await loadYamlFile<unknown>(file);
    } catch {
      continue;
    }
    const warnings: string[] = [];
    const recipe = parseApplyRecipe(data, file, true, warnings);
    if (!recipe) continue;
    const id = recipe.id || entry.name;
    const matchPaths = matchPathsOf(data);
    let score = nameMatches(id) ? 10 : 0;
    if (recipe.renames.length > 0) {
      for (const op of recipe.renames) {
        const fromRel = safeRelPath(op.from);
        const toRel = safeRelPath(renderBrandTemplate(op.to, brand));
        if (fromRel && exists(path.resolve(root, fromRel))) score += 3;
        else if (toRel && exists(path.resolve(root, toRel))) score += 3;
      }
    }
    if (score === 0) continue;
    if (!repoLooksLike(root, matchPaths)) continue;
    candidates.push({ recipe: { ...recipe, id }, matchPaths, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id));
  return candidates[0].recipe;
}

async function loadExplicitRecipe(
  raw: string,
  root: string,
  cwd: string,
  warnings: string[],
): Promise<{ recipe: ApplyRecipe | null; error: string | null }> {
  const candidates: string[] = [];
  const pushCandidate = async (base: string): Promise<void> => {
    if (candidates.length > 0 || !exists(base)) return;
    const info = await stat(base);
    candidates.push(info.isDirectory() ? path.join(base, "recipe.yaml") : base);
  };
  await pushCandidate(path.resolve(cwd, raw));
  await pushCandidate(path.resolve(root, raw));
  await pushCandidate(path.join(recipesRoot(), raw, "recipe.yaml"));
  await pushCandidate(path.join(recipesRoot(), `${raw}.yaml`));
  const file = candidates.find((candidate) => exists(candidate));
  if (!file) return { recipe: null, error: `recipe not found: ${raw}` };
  let data: unknown;
  try {
    data = await loadYamlFile<unknown>(file);
  } catch (error) {
    return { recipe: null, error: `cannot parse recipe ${file}: ${(error as Error).message}` };
  }
  const recipe = parseApplyRecipe(data, file, false, warnings);
  if (!recipe) return { recipe: null, error: `invalid recipe: ${file}` };
  return { recipe: { ...recipe, id: recipe.id || path.basename(path.dirname(file)) }, error: null };
}

/* ------------------------------------------------------------------ */
/* renames + docker refs                                              */
/* ------------------------------------------------------------------ */

/** Normalize a repo-relative path; null when absolute or escaping the repo. */
export function safeRelPath(raw: string): string | null {
  const normalized = toPosix(raw).replace(/^\.\//, "").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === ".." || part === ".")) return null;
  return normalized;
}

function globToRegExp(pattern: string): RegExp {
  const source = toPosix(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

/** True when a recipe `files:` rule explicitly targets this file. */
function recipeTargetsFile(recipe: ApplyRecipe | null, rel: string): boolean {
  if (!recipe) return false;
  return recipe.filePaths.some((pattern) => globToRegExp(pattern).test(rel));
}

/**
 * True for docker image reference lines that must never be rebranded.
 * FROM is confined to Dockerfile/Containerfile inputs and image: to
 * YAML/JSON manifests, so SQL "FROM table" lines inside JS templates or
 * unrelated prose are still rebranded normally.
 */
export function isDockerImageLine(rel: string, line: string): boolean {
  if (DOCKER_FROM_RE.test(line)) {
    const base = path.basename(rel).toLowerCase();
    return DOCKERFILE_BASENAME_RE.test(base) || base.endsWith(".dockerfile");
  }
  if (DOCKER_IMAGE_RE.test(line)) return MANIFEST_EXT_RE.test(rel);
  return false;
}

async function runRenames(
  recipe: ApplyRecipe | null,
  brand: BrandSpec,
  root: string,
  dryRun: boolean,
  warnings: string[],
): Promise<RenameOp[]> {
  const ops: RenameOp[] = [];
  if (!recipe) return ops;
  for (const op of recipe.renames) {
    const renderedTo = renderBrandTemplate(op.to, brand);
    const fromRel = safeRelPath(op.from);
    const toRel = safeRelPath(renderedTo);
    if (!fromRel || !toRel) {
      warnings.push(`recipe rename outside the repo (skipped): ${op.from} -> ${renderedTo}`);
      ops.push({ from: op.from, to: renderedTo, status: "skipped", written: false });
      continue;
    }
    if (fromRel === toRel) {
      ops.push({ from: fromRel, to: toRel, status: "skipped", written: false });
      continue;
    }
    const fromAbs = path.resolve(root, fromRel);
    const toAbs = path.resolve(root, toRel);
    const fromExists = exists(fromAbs);
    const toExists = exists(toAbs);
    if (fromExists && !toExists) {
      if (!dryRun) {
        await mkdir(path.dirname(toAbs), { recursive: true });
        await rename(fromAbs, toAbs);
      }
      ops.push({ from: fromRel, to: toRel, status: dryRun ? "would-rename" : "renamed", written: !dryRun });
    } else if (!fromExists && toExists) {
      ops.push({ from: fromRel, to: toRel, status: "already", written: false });
    } else if (!fromExists && !toExists) {
      warnings.push(`rename source missing: ${fromRel} (skipped; not present in this app version)`);
      ops.push({ from: fromRel, to: toRel, status: "missing", written: false });
    } else {
      warnings.push(`rename target already exists: ${toRel} (skipped; source kept)`);
      ops.push({ from: fromRel, to: toRel, status: "conflict", written: false });
    }
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* compose overlay                                                    */
/* ------------------------------------------------------------------ */

function pickCompose(files: string[]): string | null {
  const candidates = files.filter((file) => COMPOSE_BASENAME_RE.test(path.basename(file).toLowerCase()));
  for (const preferred of COMPOSE_PREFERENCE) {
    const hit = candidates.find((file) => path.basename(file).toLowerCase() === preferred);
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}

function chooseService(services: Record<string, unknown>, variants: string[]): string | null {
  const needles = variants.map((variant) => variant.toLowerCase()).filter(Boolean);
  for (const [serviceName, service] of Object.entries(services)) {
    const haystack = `${serviceName} ${JSON.stringify(service ?? {})}`.toLowerCase();
    if (needles.some((needle) => haystack.includes(needle))) return serviceName;
  }
  return Object.keys(services)[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* apply                                                              */
/* ------------------------------------------------------------------ */

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const parsed = parseToolArgs(argv);
  if (parsed.flags.help === true) {
    ctx.log(APPLY_USAGE);
    return 0;
  }
  const errors = flagErrors(parsed, ["json", "help", "brand", "dry-run", "recipe"]);
  if (errors.length || parsed.positionals.length > 1) {
    for (const error of errors) ctx.error(`apply: ${error}`);
    if (parsed.positionals.length > 1) ctx.error("apply: expected at most one directory argument");
    ctx.error(APPLY_USAGE);
    return 2;
  }

  const root = path.resolve(ctx.cwd, parsed.positionals[0] ?? ".");
  const dryRun = parsed.flags["dry-run"] === true;

  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    ctx.error(`apply: no such directory: ${root}`);
    return 1;
  }
  if (!rootInfo.isDirectory()) {
    ctx.error(`apply: not a directory: ${root}`);
    return 1;
  }

  const brandArg = flagString(parsed, "brand") ?? "brand.yaml";
  const brandPath = await resolveBrandPath(root, ctx.cwd, brandArg);
  if (!exists(brandPath)) {
    ctx.error(`apply: brand file not found: ${brandPath}`);
    return 1;
  }

  let loaded: unknown;
  try {
    loaded = await loadYamlFile<unknown>(brandPath);
  } catch (error) {
    ctx.error(`apply: cannot parse ${brandPath}: ${(error as Error).message}`);
    return 1;
  }
  const { brand, errors: brandErrors } = validateBrand(loaded);
  if (!brand || !brand.name || !brand.palette.primary || brand.variants.length === 0) {
    for (const error of brandErrors) ctx.error(`apply: ${error}`);
    if (!brandErrors.length) ctx.error("apply: invalid brand.yaml");
    return 1;
  }

  const warnings: string[] = [];
  const recipeArg = flagString(parsed, "recipe");
  let recipe: ApplyRecipe | null;
  if (recipeArg) {
    const resolved = await loadExplicitRecipe(recipeArg, root, ctx.cwd, warnings);
    if (!resolved.recipe) {
      ctx.error(`apply: ${resolved.error}`);
      return 1;
    }
    recipe = resolved.recipe;
  } else {
    recipe = await detectRecipe(root, brand);
  }

  const brandRel = relPosix(root, brandPath);
  const rules = buildRules(brand.variants, brand.name);
  const files = await walkRepo(root);

  // Compose plan is derived from the pristine compose file before text patches.
  const composeFile = pickCompose(files);
  let composeOp: ComposeOp | null = null;
  let overlayPath: string | null = null;
  let overlayContents: string | null = null;
  if (composeFile) {
    const composeRel = relPosix(root, composeFile);
    const rawCompose = await readTextIfSmall(composeFile, 512 * 1024);
    let services: Record<string, unknown> = {};
    if (rawCompose) {
      try {
        const doc = YAML.parse(rawCompose) as Record<string, unknown> | null;
        if (doc && typeof doc.services === "object" && doc.services) {
          services = doc.services as Record<string, unknown>;
        }
      } catch {
        services = {};
      }
    }
    const service = chooseService(services, brand.variants);
    if (service) {
      const newService = replaceLine(service, rules).text;
      const overlay = {
        "x-relabeld": { brand: brand.name, source: composeRel },
        services: {
          [newService]: {
            container_name: slugify(brand.name),
            labels: [`relabeld.brand=${brand.name}`],
            environment: { APP_NAME: brand.name },
          },
        },
      };
      overlayContents =
        `# Generated by relabeld apply — compose override for "${brand.name}".\n` +
        `# Run: docker compose -f ${composeRel} -f ${GENERATED_COMPOSE} up -d\n` +
        YAML.stringify(overlay);
      overlayPath = path.join(root, GENERATED_COMPOSE);
      composeOp = { file: GENERATED_COMPOSE, service, newService, written: !dryRun };
    }
  }

  const changed: Change[] = [];
  const skipped: Skip[] = [];
  const skipFiles = new Set([brandRel, GENERATED_COMPOSE]);

  for (const file of files) {
    const rel = relPosix(root, file);
    if (skipFiles.has(rel) || isBrandSpecFile(rel)) continue;
    if (isLicensePath(rel)) {
      skipped.push({ file: rel, reason: "license file — attribution preserved" });
      continue;
    }
    const keepHit = brand.keep.find((entry) => rel.toLowerCase().includes(entry.toLowerCase()));
    if (keepHit) {
      skipped.push({ file: rel, reason: `brand.keep: ${keepHit}` });
      continue;
    }
    if (!isScannableText(rel)) continue;
    const text = await readTextIfSmall(file);
    if (text === null || text.includes("\u0000")) continue;
    // A recipe `files:` rule is the only way to opt a docker image line back in.
    const dockerOptIn = recipeTargetsFile(recipe, rel);
    const lines = text.split("\n");
    let replacements = 0;
    let licenseLines = 0;
    let keepLines = 0;
    let dockerLines = 0;
    const outLines = lines.map((line) => {
      if (!line) return line;
      if (isLicenseLine(line)) {
        licenseLines++;
        return line;
      }
      // brand.keep holds paths (matched per file) and literal lines to protect;
      // literal matching is case-sensitive so a JSON "license" field is not a hit.
      let keepLine = false;
      for (const entry of brand.keep) {
        if (entry && line.includes(entry)) {
          keepLine = true;
          break;
        }
      }
      if (keepLine) {
        keepLines++;
        return line;
      }
      if (!dockerOptIn && isDockerImageLine(rel, line)) {
        dockerLines++;
        return line;
      }
      const result = replaceLine(line, rules);
      replacements += result.count;
      return result.text;
    });
    if (replacements > 0) {
      changed.push({ file: rel, replacements });
      if (!dryRun) await writeFile(file, outLines.join("\n"), "utf8");
    }
    if (licenseLines > 0) {
      skipped.push({ file: rel, reason: "copyright/license line preserved", lines: licenseLines });
    }
    if (keepLines > 0) {
      skipped.push({ file: rel, reason: "brand.keep line preserved", lines: keepLines });
    }
    if (dockerLines > 0) {
      skipped.push({ file: rel, reason: "docker image ref preserved (FROM/image)", lines: dockerLines });
    }
  }

  // Recipe renames run AFTER the text patch so rewritten refs point at the
  // file's new name, and idempotently (already-renamed -> status "already").
  const renames = await runRenames(recipe, brand, root, dryRun, warnings);

  // Assets: copy brand logo/favicon over every detected target of that kind.
  const assetHits = await scanAssets(root, files);
  const targetsByKind = new Map<AssetHit["kind"], AssetHit[]>();
  for (const hit of assetHits) {
    const list = targetsByKind.get(hit.kind) ?? [];
    list.push(hit);
    targetsByKind.set(hit.kind, list);
  }
  const assetOps: AssetOp[] = [];
  const copyAsset = async (kind: AssetHit["kind"], sourceRel: string | undefined): Promise<void> => {
    if (!sourceRel) return;
    const sourcePath = path.isAbsolute(sourceRel) ? sourceRel : path.resolve(root, sourceRel);
    let buffer: Buffer;
    try {
      buffer = await readFile(sourcePath);
    } catch {
      skipped.push({ file: sourceRel, reason: `asset source missing for ${kind}` });
      return;
    }
    const targets = targetsByKind.get(kind) ?? [];
    if (targets.length === 0) {
      skipped.push({ file: sourceRel, reason: `no ${kind} target detected in repo` });
      return;
    }
    for (const target of targets) {
      const targetPath = path.resolve(root, target.file);
      const from = path.isAbsolute(sourceRel) ? sourceRel : toPosix(sourceRel);
      if (targetPath === sourcePath) {
        assetOps.push({ kind, from, file: target.file, bytes: buffer.length, written: false });
        continue;
      }
      if (!dryRun) await writeFile(targetPath, buffer);
      assetOps.push({ kind, from, file: target.file, bytes: buffer.length, written: !dryRun });
    }
  };
  await copyAsset("logo", brand.logo);
  await copyAsset("favicon", brand.favicon);

  // Write the compose override last (plan was computed from pristine input).
  let composeWritten = false;
  if (overlayPath && overlayContents) {
    if (!dryRun) {
      await writeFile(overlayPath, overlayContents, "utf8");
      composeWritten = true;
    }
    if (composeOp) composeOp.written = !dryRun;
  } else if (!composeFile) {
    skipped.push({ file: GENERATED_COMPOSE, reason: "no compose file found" });
  }

  const totalReplacements = changed.reduce((sum, entry) => sum + entry.replacements, 0);
  const renamesPerformed = renames.filter((op) => op.status === "renamed" || op.status === "would-rename").length;
  const duplicateSkips = new Map<string, Skip>();
  for (const skip of skipped) {
    const key = `${skip.file}|${skip.reason}`;
    if (!duplicateSkips.has(key)) duplicateSkips.set(key, skip);
  }
  const skipList = [...duplicateSkips.values()];
  const recipeInfo = recipe
    ? { id: recipe.id, name: recipe.name, source: toPosix(recipe.source), auto: recipe.auto }
    : null;

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          brand: brand.name,
          recipe: recipeInfo,
          changed,
          skipped: skipList,
          renames,
          assets: assetOps,
          compose: composeOp,
          warnings,
          totals: {
            filesChanged: changed.length,
            replacements: totalReplacements,
            renamesPerformed,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  ctx.log(`relabeld apply — ${root}`);
  ctx.log(`brand: ${brand.name} (${brandPath})`);
  if (recipeInfo) {
    ctx.log(`recipe: ${recipeInfo.id} (${recipeInfo.auto ? "auto-detected" : "explicit"}: ${recipeInfo.source})`);
  } else {
    ctx.log("recipe: none (pass --recipe <id> to enable file renames)");
  }
  ctx.log(dryRun ? "mode: DRY-RUN — no files written" : "mode: apply");
  ctx.log("");
  if (changed.length === 0) {
    ctx.log("changed: 0 files (nothing matched the configured variants)");
  } else {
    ctx.log(`changed ${changed.length} files, ${totalReplacements} replacements`);
    for (const entry of changed) {
      ctx.log(`  ${entry.file.padEnd(42)} ${entry.replacements}`);
    }
  }
  if (renames.length) {
    ctx.log("");
    ctx.log(`renames ${dryRun ? "planned" : "performed"} ${renamesPerformed}:`);
    for (const op of renames) {
      const arrow = op.status === "already" ? "already" : op.status;
      ctx.log(`  ${op.from.padEnd(46)} → ${op.to.padEnd(46)} ${arrow}`);
    }
  }
  if (skipList.length) {
    ctx.log("");
    ctx.log(`skipped ${skipList.length}:`);
    for (const skip of skipList) {
      const suffix = skip.lines ? ` (${skip.lines} lines)` : "";
      ctx.log(`  ${skip.file.padEnd(42)} ${skip.reason}${suffix}`);
    }
  }
  if (assetOps.length) {
    ctx.log("");
    ctx.log(`assets ${dryRun ? "would copy" : "copied"}:`);
    for (const op of assetOps) {
      ctx.log(`  ${op.kind.padEnd(8)} ${op.file.padEnd(36)} ← ${op.from} (${op.bytes} B)`);
    }
  }
  if (composeOp) {
    ctx.log("");
    ctx.log(
      `compose ${dryRun ? "would write" : "wrote"}: ${composeOp.file} (service ${composeOp.service} → ${composeOp.newService})`,
    );
  }
  if (warnings.length) {
    ctx.log("");
    ctx.log(`warnings ${warnings.length}:`);
    for (const warning of warnings) ctx.log(`  ${warning}`);
  }
  ctx.log("");
  ctx.log(dryRun ? "next: relabeld apply --brand brand.yaml" : "next: relabeld verify --url http://localhost:<port>");
  if (composeWritten) ctx.log(`      docker compose -f ${composeOp?.file ?? GENERATED_COMPOSE} up -d`);
  return 0;
}
