/**
 * relabeld scan — detect brand surfaces in a self-hosted app (read-only).
 *
 * This module is also the shared detection library for `init` and `apply`:
 * repo walking, brand-token seeding, variant expansion, word-boundary
 * matching, license/copyright classification and asset discovery live here.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AssetHit, Ctx, Finding, FindingKind, ScanResult } from "./types.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  IGNORE_DIRS,
  escapeRegExp,
  formatBytes,
  isTextFile,
  nowIso,
  parseByteLimit,
  readTextChecked,
  readTextIfSmall,
  relPosix,
  sha256,
  toPosix,
  writeJson,
} from "./util.js";
import type { TextSkipReason } from "./util.js";

export const SCAN_USAGE = [
  "Usage: relabeld scan [dir] [--json] [--save]",
  "",
  "Detect brand surfaces (strings, config, docs, CI, license lines, assets)",
  "in a self-hosted app. Read-only unless --save is given.",
  "",
  "  --json                machine-readable ScanResult",
  "  --save                write .relabel/scan.json inside <dir>",
  "  --max-file-bytes <n>  largest file to read as text (default 524288); larger",
  "                        files are reported as skipped, never patched/scanned",
].join("\n");

const MAX_FILES = 20000;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/** Hidden directories that still carry brand surface (CI, devcontainers). */
const HIDDEN_DIR_ALLOW = new Set([".github", ".gitlab", ".circleci", ".devcontainer", ".vscode"]);

/** Infrastructure image/service names that are never the app's own brand. */
const INFRA_NAMES = new Set([
  "postgres", "postgresql", "mysql", "mariadb", "mongo", "mongodb", "redis",
  "valkey", "memcached", "nginx", "caddy", "traefik", "rabbitmq",
  "elasticsearch", "opensearch", "kibana", "minio", "grafana", "prometheus",
  "loki", "vault", "consul", "docker", "dind", "alpine", "ubuntu", "debian",
  "node", "python", "golang", "busybox", "hello-world", "portainer",
  "watchtower", "certbot", "influxdb", "clickhouse", "keycloak", "sentry",
  "mailhog", "adminer", "pgadmin", "tomcat", "httpd", "nginx-proxy",
  "cloudflared", "ofelia", "healthcheck", "mailserver", "smtp", "ftp",
]);

/** Generic dir/project names that carry no brand signal. */
const GENERIC_NAMES = new Set([
  "app", "apps", "application", "src", "source", "test", "tests", "testing",
  "demo", "demo-app", "example", "examples", "template", "templates",
  "project", "projects", "repo", "repository", "website", "web", "site",
  "frontend", "backend", "client", "server", "api", "lib", "libs", "package",
  "packages", "workspace", "work", "home", "root", "tmp", "temp", "dist",
  "build", "out", "main", "master", "default", "my-app", "myapp",
  "hello-world", "sample", "samples", "boilerplate", "scaffold", "starter",
  "node", "nodejs", "typescript", "javascript", "python", "django", "react",
  "vue", "next", "vite", "docker", "docker-compose", "selfhost", "self-hosted",
  "local", "dev", "prod", "production", "development", "worker", "migrate",
  "db", "database", "cache", "queue", "scheduler", "cron", "celery", "beat",
  "proxy", "gateway", "static", "public", "assets", "docs", "scripts",
  "tailwind", "vite", "webpack", "esbuild", "gulp", "storybook", "rollup",
  "builder", "buildkit", "init", "setup", "backup", "restore",
  "codespaces", "gitpod", "devcontainer", "replit", "glitch", "render",
  "railway", "fly", "flyio", "vercel", "netlify", "supabase",
]);

const ENV_KEYS = new Set([
  "APP_NAME", "SITE_NAME", "BRAND", "BRAND_NAME", "PRODUCT", "PRODUCT_NAME",
  "COMPANY", "COMPANY_NAME", "DISPLAY_NAME", "APP_TITLE", "SITE_TITLE",
]);

const COMPOSE_BASENAME_RE = /^(docker[-_.]?)?compose([.\w-]*)?\.ya?ml$/i;

const LICENSE_BASENAME_RE = /^(licen[cs]e|copying|notice|unlicense|copyright)([._-].*)?$/i;
const LICENSE_LINE_RE =
  /\bcopyright\b|\(c\)\s*\d{4}|\u00a9|spdx-license-identifier|all rights reserved|licensed under/i;

/* ------------------------------------------------------------------ */
/* shared arg parsing (scan/init/apply)                               */
/* ------------------------------------------------------------------ */

export interface ParsedToolArgs {
  positionals: string[];
  flags: Record<string, string | true>;
  errors: string[];
}

const BOOLEAN_FLAGS = new Set(["json", "help", "save", "force", "dry-run"]);

/**
 * Parse `<positionals> [--flag [value]]` argv as handed to a command module.
 * Unknown options are reported instead of silently ignored.
 */
export function parseToolArgs(argv: string[]): ParsedToolArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags, errors };
}

/** Check flag names against a command allow-list (global --cwd tolerated). */
export function flagErrors(parsed: ParsedToolArgs, allowed: string[]): string[] {
  const ok = new Set([...allowed, "cwd"]);
  const errors = [...parsed.errors];
  for (const key of Object.keys(parsed.flags)) {
    if (!ok.has(key)) errors.push(`unknown option: --${key}`);
  }
  return errors;
}

export function flagString(parsed: ParsedToolArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* walking                                                            */
/* ------------------------------------------------------------------ */

/** Walk a repo, skipping build/vendor dirs and hidden dirs except CI ones. */
export async function walkRepo(root: string, maxFiles = MAX_FILES): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && !HIDDEN_DIR_ALLOW.has(entry.name)) continue;
        await rec(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

/** True for license/attribution files, which must never be rewritten. */
export function isLicensePath(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (LICENSE_BASENAME_RE.test(base)) return true;
  const posix = toPosix(rel).toLowerCase();
  return /(^|\/)(licen[cs]es|third[_-]?party[_-]?licen[cs]es)\//.test(posix);
}

/** True for legal/copyright lines inside otherwise patchable files. */
export function isLicenseLine(line: string): boolean {
  return LICENSE_LINE_RE.test(line);
}

/** True for brand.yaml itself, which describes the brand instead of wearing it. */
export function isBrandSpecFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return rel === base && (base === "brand.yaml" || base === "brand.yml");
}

const EXTRA_TEXT_BASENAMES = new Set(["caddyfile", "procfile", "gemfile", "justfile"]);

/** Text files worth scanning/patching (util's set plus manifest/extensionless). */
export function isScannableText(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (isLicensePath(rel)) return true;
  if (base.endsWith(".webmanifest")) return true;
  if (EXTRA_TEXT_BASENAMES.has(base)) return true;
  return isTextFile(rel);
}

function isGenericName(name: string): boolean {
  const value = name.trim().toLowerCase();
  if (!value || value.length < 2) return true;
  if (GENERIC_NAMES.has(value) || INFRA_NAMES.has(value)) return true;
  return /^\d+$/.test(value);
}

/* ------------------------------------------------------------------ */
/* brand token seeding + variants                                     */
/* ------------------------------------------------------------------ */

export interface BrandSeed {
  raw: string;
  source: string;
  file?: string;
}

const VERSION_SUFFIX_RE = /(?:[-_. ]v?\d+(?:\.\d+)+(?:[-_.][0-9A-Za-z.-]+)?)$/;

/** "uptime-kuma-1.23.17" -> "uptime-kuma" (release dirs are not brand names). */
function stripVersionSuffix(value: string): string {
  let out = value.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(VERSION_SUFFIX_RE, "").replace(/[-_. ]+$/, "");
    if (next === out || next.length < 3) break;
    out = next;
  }
  return out;
}

function normalizeSeed(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = stripVersionSuffix(raw);
  const value = stripped.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();
  if (!value || value.length < 3 || value.length > 60) return null;
  if (/^(true|false|null|none|undefined|example|changeme|localhost|latest|default)$/i.test(value)) {
    return null;
  }
  if (/^https?:\/\//i.test(value) || /^[\d.]+$/.test(value)) return null;
  if (/[{}<>$]/.test(value)) return null; // templated placeholder, not a brand
  if (isGenericName(value)) return null;
  return value;
}

function unquote(value: string): string {
  return value.trim().replace(/^["'`]/, "").replace(/["'`]\s*$/, "").trim();
}

function imageBasename(image: string): string | null {
  let value = image.trim();
  if (!value || value.startsWith(".") || value.startsWith("/")) return null;
  value = value.split("@")[0];
  const slash = value.lastIndexOf("/");
  if (slash >= 0) value = value.slice(slash + 1);
  const colon = value.indexOf(":");
  if (colon >= 0) value = value.slice(0, colon);
  return value || null;
}

function pushSeed(seeds: BrandSeed[], seen: Set<string>, raw: unknown, source: string, file?: string): void {
  const value = normalizeSeed(raw);
  if (!value) return;
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  seeds.push({ raw: value, source, file });
}

async function seedsFromPackageJson(
  root: string,
  seeds: BrandSeed[],
  seen: Set<string>,
): Promise<void> {
  const file = path.join(root, "package.json");
  const raw = await readTextIfSmall(file, 256 * 1024);
  if (!raw) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const rel = "package.json";
  for (const key of ["productName", "displayName", "name"]) {
    const value = pkg[key];
    if (typeof value !== "string") continue;
    const bare = value.startsWith("@") ? value.slice(value.indexOf("/") + 1) : value;
    pushSeed(seeds, seen, bare, `package.json:${key}`, rel);
  }
}

async function seedsFromCompose(
  root: string,
  files: string[],
  seeds: BrandSeed[],
  seen: Set<string>,
): Promise<void> {
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    if (!COMPOSE_BASENAME_RE.test(base)) continue;
    const raw = await readTextIfSmall(file, 512 * 1024);
    if (!raw) continue;
    let doc: unknown;
    try {
      doc = YAML.parse(raw);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    const rel = relPosix(root, file);
    const obj = doc as Record<string, unknown>;
    if (typeof obj.name === "string") pushSeed(seeds, seen, obj.name, "compose:name", rel);
    const services = obj.services;
    if (!services || typeof services !== "object") continue;
    for (const [serviceName, service] of Object.entries(services as Record<string, unknown>)) {
      pushSeed(seeds, seen, serviceName, "compose:service", rel);
      if (!service || typeof service !== "object") continue;
      const svc = service as Record<string, unknown>;
      if (typeof svc.image === "string") {
        const image = imageBasename(svc.image);
        if (image) pushSeed(seeds, seen, image, "compose:image", rel);
      }
      if (typeof svc.container_name === "string") {
        pushSeed(seeds, seen, svc.container_name, "compose:container_name", rel);
      }
      const environment = svc.environment;
      if (Array.isArray(environment)) {
        for (const item of environment) {
          if (typeof item !== "string") continue;
          const eq = item.indexOf("=");
          if (eq < 0) continue;
          const key = item.slice(0, eq).trim();
          if (ENV_KEYS.has(key)) pushSeed(seeds, seen, unquote(item.slice(eq + 1)), `compose:env:${key}`, rel);
        }
      } else if (environment && typeof environment === "object") {
        for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
          if (ENV_KEYS.has(key)) pushSeed(seeds, seen, unquote(String(value ?? "")), `compose:env:${key}`, rel);
        }
      }
    }
  }
}

async function seedsFromReadme(
  root: string,
  files: string[],
  seeds: BrandSeed[],
  seen: Set<string>,
): Promise<void> {
  const readmes = files
    .filter((file) => /^readme\.(md|mdx|markdown|txt)$/i.test(path.basename(file)))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  const readme = readmes.find((file) => path.dirname(file) === path.resolve(root)) ?? readmes[0];
  if (!readme) return;
  const raw = await readTextIfSmall(readme, 512 * 1024);
  if (!raw) return;
  const lines = raw.split("\n").slice(0, 120);
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const title = match[1]
      .replace(/[`*_[\]]/g, "")
      .replace(/\s+[—–-].*$/, "")
      .trim();
    pushSeed(seeds, seen, title, "readme:h1", relPosix(root, readme));
    break;
  }
}

async function seedsFromEnvFiles(
  root: string,
  files: string[],
  seeds: BrandSeed[],
  seen: Set<string>,
): Promise<void> {
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    const envish = base.startsWith(".env") || base === "env" || /^env\.(example|sample|template)$/.test(base);
    if (!envish) continue;
    const raw = await readTextIfSmall(file, 256 * 1024);
    if (!raw) continue;
    const rel = relPosix(root, file);
    for (const line of raw.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (!ENV_KEYS.has(key)) continue;
      const value = unquote(match[2].replace(/\s+#.*$/, ""));
      pushSeed(seeds, seen, value, `env:${key}`, rel);
    }
  }
}

/** Collect brand-name candidate seeds from a repo's metadata. */
export async function collectSeeds(root: string, files: string[]): Promise<BrandSeed[]> {
  const seeds: BrandSeed[] = [];
  const seen = new Set<string>();
  pushSeed(seeds, seen, path.basename(path.resolve(root)), "dirname");
  await seedsFromPackageJson(root, seeds, seen);
  await seedsFromCompose(root, files, seeds, seen);
  await seedsFromReadme(root, files, seeds, seen);
  await seedsFromEnvFiles(root, files, seeds, seen);
  return seeds;
}

/** Canonical display form: "pulse-status" -> "Pulse Status", camelCase kept. */
export function canonicalName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let words = trimmed.split(/[_\-]+/).filter(Boolean);
  if (words.length === 1) words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const single =
    words.length === 1 && /[a-z]/.test(words[0]) && /[A-Z]/.test(words[0]) && !/[\s_-]/.test(words[0]);
  if (single) return words[0];
  return words.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word)).join(" ");
}

const variantCache = new Map<string, string[]>();

/** All case/separator shapes a brand token can take in source files. */
export function variantsFor(token: string): string[] {
  const cached = variantCache.get(token);
  if (cached) return cached;
  const words = token.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return [];
  const lower = words.map((word) => word.toLowerCase());
  const cap = words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  const variants = new Map<string, string>();
  const add = (value: string): void => {
    if (value.length < 3) return;
    const key = value.toLowerCase();
    if (!variants.has(key)) variants.set(key, value);
  };
  add(token);
  add(lower.join(" "));
  add(cap.join(" "));
  add(lower.join("-"));
  add(cap.join("-"));
  add(lower.join("_"));
  add(lower.join("").toUpperCase());
  add(lower.join(""));
  add(cap.join(""));
  add(lower.join(" ").toUpperCase());
  add(lower.join("-").toUpperCase());
  add(lower.join("_").toUpperCase());
  const list = [...variants.values()].sort((a, b) => b.length - a.length);
  variantCache.set(token, list);
  return list;
}

export interface TokenRule {
  variant: string;
  re: RegExp;
}

/** Compile one case-insensitive word-boundary matcher per token. */
export function compileTokenRule(token: string): TokenRule[] {
  const variants = variantsFor(token);
  if (!variants.length) return [];
  const alternatives = variants.map(escapeRegExp).join("|");
  return [{ variant: token, re: new RegExp(`(?<![A-Za-z0-9])(${alternatives})(?![A-Za-z0-9])`, "gi") }];
}

export interface DetectedMatch {
  start: number;
  end: number;
  text: string;
  token: string;
}

/** Find non-overlapping brand matches on one line, longest match wins. */
export function detectInLine(line: string, tokens: string[]): DetectedMatch[] {
  if (!line || tokens.length === 0) return [];
  const raw: Array<DetectedMatch & { length: number }> = [];
  for (const token of tokens) {
    for (const rule of compileTokenRule(token)) {
      const re = rule.re;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        raw.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
          token,
          length: match[0].length,
        });
        if (match[0].length === 0) re.lastIndex++;
      }
    }
  }
  raw.sort((a, b) => a.start - b.start || b.length - a.length);
  const kept: DetectedMatch[] = [];
  let lastEnd = -1;
  for (const hit of raw) {
    if (hit.start < lastEnd) continue;
    kept.push({ start: hit.start, end: hit.end, text: hit.text, token: hit.token });
    lastEnd = hit.end;
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* classification                                                     */
/* ------------------------------------------------------------------ */

const ASSET_KIND_PATTERNS: Array<{ kind: AssetHit["kind"]; re: RegExp }> = [
  {
    kind: "og-image",
    re: /(^|[-_.])(og[-_]?image|opengraph|open-graph|social[-_]?card|og)([-_.][^/]*)?\.(png|jpe?g|webp|svg)$/i,
  },
  {
    kind: "favicon",
    re: /(^|[-_.])(favicon|apple-touch-icon|app-icon|appicon|touch-icon)([-_.][^/]*)?\.(ico|png|jpe?g|webp|svg)$/i,
  },
  {
    kind: "logo",
    re: /(^|[-_.])(logo|wordmark|brandmark|logomark|brand[-_]?mark)([-_.][^/]*)?\.(png|jpe?g|webp|svg|ico)$/i,
  },
  {
    kind: "logo",
    re: /(^|[-_.])icon([-_.][^/]*)?\.(png|jpe?g|webp|svg)$/i,
  },
];

/** Classify an image file by filename; null when it is not a brand asset. */
export function assetKindFor(base: string): AssetHit["kind"] | null {
  for (const { kind, re } of ASSET_KIND_PATTERNS) {
    if (re.test(base)) return kind;
  }
  return null;
}

/** Classify a finding: license lines win, then CI, docs, config, string. */
export function classifyKind(rel: string, line: string): FindingKind {
  if (isLicensePath(rel) || isLicenseLine(line)) return "license";
  const base = path.basename(rel).toLowerCase();
  if (
    rel.startsWith(".github/") ||
    rel.startsWith(".circleci/") ||
    rel.startsWith(".gitlab/") ||
    base === ".gitlab-ci.yml" ||
    base === "jenkinsfile" ||
    /(^|\/)\.github\//.test(rel)
  ) {
    return "ci";
  }
  if (
    /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(base) ||
    /^readme([.\w-]*)$/i.test(base) ||
    rel.startsWith("docs/")
  ) {
    return "docs";
  }
  if (
    /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|env|example|sample|template|xml)$/i.test(base) ||
    base.startsWith(".env") ||
    /(^|\/)(config|settings|conf)\//.test(rel)
  ) {
    return "config";
  }
  return "string";
}

function confidenceFor(match: DetectedMatch): "high" | "medium" | "low" {
  if (match.text === match.token) return "high";
  if (match.text.toLowerCase() === match.token.toLowerCase()) return "medium";
  return "low";
}

function suggestionFor(kind: FindingKind): string {
  switch (kind) {
    case "license":
      return "keep — attribution / legal line";
    case "docs":
      return "update docs wording to the new brand";
    case "ci":
      return "update CI job/image label to the new brand";
    case "config":
      return "update config default to brand.name";
    case "asset":
      return "replace asset with the brand asset";
    default:
      return "replace with brand.name";
  }
}

/* ------------------------------------------------------------------ */
/* assets                                                             */
/* ------------------------------------------------------------------ */

/** List brand-relevant assets (logo / favicon / og-image) with hashes. */
export async function scanAssets(root: string, files: string[]): Promise<AssetHit[]> {
  const out: AssetHit[] = [];
  for (const file of files) {
    const kind = assetKindFor(path.basename(file));
    if (!kind) continue;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) continue;
      const buffer = await readFile(file);
      out.push({ file: relPosix(root, file), kind, bytes: info.size, sha256: sha256(buffer) });
    } catch {
      // unreadable asset: ignore, scan must not crash on one bad file
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/* ------------------------------------------------------------------ */
/* scan                                                               */
/* ------------------------------------------------------------------ */

export interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface SkippedFileInfo {
  file: string;
  reason: TextSkipReason;
  bytes: number;
}

/** ScanResult plus data-safety accounting (files deliberately not read). */
export interface ScanResultWithDetails extends ScanResult {
  skipped: SkippedFileInfo[];
  maxFileBytes: number;
}

/** Scan a repo directory and return a complete ScanResult. */
export async function scanDir(dir: string, options: ScanOptions = {}): Promise<ScanResultWithDetails> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const skipped: SkippedFileInfo[] = [];
  const root = path.resolve(dir);
  const files = await walkRepo(root, options.maxFiles ?? MAX_FILES);
  const seeds = await collectSeeds(root, files);

  const tokenSet = new Map<string, string>();
  for (const seed of seeds) {
    const canonical = canonicalName(seed.raw);
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (!tokenSet.has(key)) tokenSet.set(key, canonical);
  }
  const brandTokens = [...tokenSet.values()].sort((a, b) => a.localeCompare(b));

  const findings: Finding[] = [];
  for (const file of files) {
    const rel = relPosix(root, file);
    if (isBrandSpecFile(rel)) continue;
    if (!isScannableText(rel)) continue;
    // Data-safety: never decode a file we could not rewrite byte-for-byte.
    const read = await readTextChecked(file, maxFileBytes);
    if (!read.ok) {
      skipped.push({ file: rel, reason: read.reason ?? "unreadable", bytes: read.bytes });
      continue;
    }
    const text = read.text;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line || line.length > 100_000) continue; // skip pathological/minified blobs
      for (const hit of detectInLine(line, brandTokens)) {
        const kind = classifyKind(rel, line);
        findings.push({
          file: rel,
          line: index + 1,
          kind,
          token: hit.token,
          match: hit.text,
          confidence: confidenceFor(hit),
          suggestion: suggestionFor(kind),
        });
      }
    }
  }

  const assets = await scanAssets(root, files);

  // Old-brand asset filenames are brand surface too (they need re-exporting).
  for (const asset of assets) {
    for (const hit of detectInLine(path.basename(asset.file), brandTokens)) {
      findings.push({
        file: asset.file,
        kind: "asset",
        token: hit.token,
        match: hit.text,
        confidence: "high",
        suggestion: suggestionFor("asset"),
      });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  const summaries: Record<string, number> = { string: 0, asset: 0, config: 0, docs: 0, ci: 0, license: 0 };
  for (const finding of findings) summaries[finding.kind] = (summaries[finding.kind] ?? 0) + 1;

  skipped.sort((a, b) => a.file.localeCompare(b.file));

  return {
    root,
    scannedFiles: files.length,
    brandTokens,
    findings,
    assets,
    summaries,
    generatedAt: nowIso(),
    skipped,
    maxFileBytes,
  };
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function humanReport(result: ScanResultWithDetails, saved: string | null): string[] {
  const lines: string[] = [];
  const kinds = Object.entries(result.summaries)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  lines.push(`relabeld scan — ${result.root}`);
  lines.push(
    `scanned ${result.scannedFiles} files · brand tokens ${result.brandTokens.length} · findings ${result.findings.length} · assets ${result.assets.length}`,
  );
  lines.push("");
  if (result.brandTokens.length) {
    lines.push(`brand tokens: ${result.brandTokens.join(", ")}`);
  } else {
    lines.push("brand tokens: none detected (pass a recipe or set variants manually)");
  }
  lines.push(`findings: ${kinds.length ? kinds.join(", ") : "none"}`);
  lines.push("");
  const shown = result.findings.slice(0, 40);
  for (const finding of shown) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`  ${finding.kind.padEnd(7)} ${location.padEnd(38)} ${finding.match}`);
  }
  if (result.findings.length > shown.length) {
    lines.push(`  … ${result.findings.length - shown.length} more findings`);
  }
  if (result.assets.length) {
    lines.push("");
    lines.push("assets:");
    for (const asset of result.assets) {
      lines.push(
        `  ${asset.kind.padEnd(8)} ${asset.file.padEnd(38)} ${asset.bytes} B  sha256 ${shortHash(asset.sha256)}`,
      );
    }
  }
  if (result.skipped.length) {
    lines.push("");
    const bytes = result.skipped.reduce((sum, entry) => sum + entry.bytes, 0);
    lines.push(
      `skipped ${result.skipped.length} files (${formatBytes(bytes)}) — not read, never patched:`,
    );
    for (const entry of result.skipped) {
      const reason =
        entry.reason === "invalid-utf8"
          ? "not valid UTF-8 (binary/latin1)"
          : entry.reason === "oversize"
            ? `oversize (${formatBytes(entry.bytes)} > --max-file-bytes ${formatBytes(result.maxFileBytes)})`
            : entry.reason === "binary"
              ? "binary (NUL bytes)"
              : entry.reason;
      lines.push(`  ${entry.file.padEnd(42)} ${reason}`);
    }
    lines.push("  raise the limit with --max-file-bytes <n> if these must be scanned");
  }
  if (saved) {
    lines.push("");
    lines.push(`saved: ${saved}`);
  }
  lines.push("");
  lines.push('next: relabeld init --name "Your Brand" --domain example.com');
  return lines;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const parsed = parseToolArgs(argv);
  if (parsed.flags.help === true) {
    ctx.log(SCAN_USAGE);
    return 0;
  }
  const errors = flagErrors(parsed, ["json", "save", "help", "max-file-bytes"]);
  if (errors.length || parsed.positionals.length > 1) {
    for (const error of errors) ctx.error(`scan: ${error}`);
    if (parsed.positionals.length > 1) ctx.error("scan: expected at most one directory argument");
    ctx.error(SCAN_USAGE);
    return 2;
  }

  const maxFileBytesRaw = parsed.flags["max-file-bytes"];
  const maxFileBytes = maxFileBytesRaw === undefined ? DEFAULT_MAX_FILE_BYTES : parseByteLimit(maxFileBytesRaw);
  if (maxFileBytes === null) {
    ctx.error("scan: --max-file-bytes requires a positive integer");
    ctx.error(SCAN_USAGE);
    return 2;
  }

  const target = path.resolve(ctx.cwd, parsed.positionals[0] ?? ".");
  let info;
  try {
    info = await stat(target);
  } catch {
    ctx.error(`scan: no such directory: ${target}`);
    return 1;
  }
  if (!info.isDirectory()) {
    ctx.error(`scan: not a directory: ${target}`);
    return 1;
  }

  const result = await scanDir(target, { maxFileBytes });
  let saved: string | null = null;
  if (parsed.flags.save === true) {
    const savePath = path.join(target, ".relabel", "scan.json");
    await writeJson(savePath, result);
    saved = relPosix(target, savePath);
  }

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const line of humanReport(result, saved)) ctx.log(line);
  return 0;
}
