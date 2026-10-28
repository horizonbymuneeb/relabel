import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor",
  ".venv", "venv", "__pycache__", ".relabel", ".next", ".cache", "target",
]);

export const TEXT_EXT = new Set([
  ".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".py", ".rb", ".go", ".rs", ".php",
  ".java", ".kt", ".cs", ".sh", ".bash", ".env", ".example", ".xml", ".svg",
  ".sql", ".graphql", ".mdx", ".astro", ".ejs", ".hbs", ".jinja", ".j2",
]);

export function isTextFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base === "makefile") return true;
  return TEXT_EXT.has(path.extname(base));
}

export async function walk(root: string, opts: { maxFiles?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  const maxFiles = opts.maxFiles ?? 20000;
  async function rec(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await rec(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

export async function readTextIfSmall(file: string, maxBytes = 512 * 1024): Promise<string | null> {
  try {
    const st = await stat(file);
    if (st.size > maxBytes) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function loadYamlFile<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return YAML.parse(raw) as T;
}

export async function saveYamlFile(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, YAML.stringify(data), "utf8");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  const re = new RegExp(escapeRegExp(needle), "gi");
  return (hay.match(re) ?? []).length;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function relPosix(root: string, file: string): string {
  return toPosix(path.relative(root, file)) || path.basename(file);
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export function nowIso(): string {
  return new Date().toISOString();
}
