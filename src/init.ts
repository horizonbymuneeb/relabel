/**
 * relabeld init — derive brand.yaml from a scan plus explicit brand flags.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { BrandSpec, Ctx } from "./types.js";
import { exists, relPosix, saveYamlFile, toPosix } from "./util.js";
import { flagErrors, flagString, isLicensePath, parseToolArgs, scanDir, walkRepo } from "./scan.js";

export const INIT_USAGE = [
  "Usage: relabeld init [dir] --name <brand> [options]",
  "",
  "Write brand.yaml derived from the repo scan and the given brand.",
  "",
  "  --name <text>        new brand name (required), e.g. \"Nova Demo\"",
  "  --domain <host>      public domain, e.g. demo.example.com",
  "  --primary <#hex>     primary brand colour (default #2563EB)",
  "  --accent <#hex>      accent brand colour",
  "  --logo <path>        logo file to copy over detected logo assets",
  "  --favicon <path>     favicon file to copy over detected favicons",
  "  --email-from <addr>  sender address, e.g. hello@demo.example.com",
  "  --force              overwrite an existing brand.yaml",
].join("\n");

const HEX_COLOR_RE = /^#?[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeColor(value: string): string | null {
  if (!HEX_COLOR_RE.test(value.trim())) return null;
  const trimmed = value.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** Resolve a user-supplied asset path against the repo root, then the cwd. */
async function resolveAssetPath(raw: string, root: string, cwd: string): Promise<string | null> {
  const candidates = [path.resolve(root, raw), path.resolve(cwd, raw)];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const parsed = parseToolArgs(argv);
  if (parsed.flags.help === true) {
    ctx.log(INIT_USAGE);
    return 0;
  }
  const errors = flagErrors(parsed, [
    "json", "help", "name", "domain", "primary", "accent", "logo", "favicon", "email-from", "force",
  ]);
  if (errors.length || parsed.positionals.length > 1) {
    for (const error of errors) ctx.error(`init: ${error}`);
    if (parsed.positionals.length > 1) ctx.error("init: expected at most one directory argument");
    ctx.error(INIT_USAGE);
    return 2;
  }

  const root = path.resolve(ctx.cwd, parsed.positionals[0] ?? ".");
  const name = flagString(parsed, "name")?.trim();
  if (!name) {
    ctx.error("init: --name is required");
    ctx.error(INIT_USAGE);
    return 2;
  }

  const domain = flagString(parsed, "domain")?.trim();
  if (domain && !DOMAIN_RE.test(domain)) {
    ctx.error(`init: invalid --domain: ${domain}`);
    return 2;
  }
  const primaryRaw = flagString(parsed, "primary") ?? "#2563EB";
  const primary = normalizeColor(primaryRaw);
  if (!primary) {
    ctx.error(`init: invalid --primary colour: ${primaryRaw}`);
    return 2;
  }
  const accentRaw = flagString(parsed, "accent");
  const accent = accentRaw ? normalizeColor(accentRaw) : undefined;
  if (accentRaw && !accent) {
    ctx.error(`init: invalid --accent colour: ${accentRaw}`);
    return 2;
  }
  const emailFrom = flagString(parsed, "email-from")?.trim();
  if (emailFrom && !EMAIL_RE.test(emailFrom)) {
    ctx.error(`init: invalid --email-from: ${emailFrom}`);
    return 2;
  }

  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    ctx.error(`init: no such directory: ${root}`);
    return 1;
  }
  if (!rootInfo.isDirectory()) {
    ctx.error(`init: not a directory: ${root}`);
    return 1;
  }

  const logoRaw = flagString(parsed, "logo");
  const faviconRaw = flagString(parsed, "favicon");
  const logoFile = logoRaw ? await resolveAssetPath(logoRaw, root, ctx.cwd) : null;
  if (logoRaw && !logoFile) {
    ctx.error(`init: logo not found: ${logoRaw}`);
    return 1;
  }
  const faviconFile = faviconRaw ? await resolveAssetPath(faviconRaw, root, ctx.cwd) : null;
  if (faviconRaw && !faviconFile) {
    ctx.error(`init: favicon not found: ${faviconRaw}`);
    return 1;
  }
  const storePath = (file: string): string => {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
    return toPosix(file);
  };

  const outFile = path.join(root, "brand.yaml");
  if (exists(outFile) && parsed.flags.force !== true) {
    ctx.error(`init: brand.yaml already exists at ${outFile} (use --force to overwrite)`);
    return 1;
  }

  const scan = await scanDir(root);

  // License files are kept verbatim; copyright lines inside other files are
  // handled per-line by apply, so only whole license files land in brand.keep.
  const files = await walkRepo(root);
  const licenseFiles = files.map((file) => relPosix(root, file)).filter((rel) => isLicensePath(rel));
  const keep = licenseFiles.length ? licenseFiles : ["LICENSE"];

  const specs: BrandSpec = {
    name,
    ...(domain ? { domain } : {}),
    palette: { primary, ...(accent ? { accent } : {}) },
    ...(logoFile ? { logo: storePath(logoFile) } : {}),
    ...(faviconFile ? { favicon: storePath(faviconFile) } : {}),
    ...(emailFrom ? { emailFrom } : {}),
    variants: [...scan.brandTokens],
    keep,
  };

  await saveYamlFile(outFile, specs);

  const savedRel = relPosix(root, outFile) || "brand.yaml";
  if (ctx.json) {
    console.log(JSON.stringify({ path: toPosix(outFile), brand: specs }, null, 2));
    return 0;
  }
  ctx.log(`relabeld init — ${root}`);
  ctx.log(`wrote ${savedRel}`);
  ctx.log(`  name      ${specs.name}`);
  if (specs.domain) ctx.log(`  domain    ${specs.domain}`);
  ctx.log(`  palette   ${specs.palette.primary}${specs.palette.accent ? ` / ${specs.palette.accent}` : ""}`);
  if (specs.logo) ctx.log(`  logo      ${specs.logo}`);
  if (specs.favicon) ctx.log(`  favicon   ${specs.favicon}`);
  if (specs.emailFrom) ctx.log(`  emailFrom ${specs.emailFrom}`);
  ctx.log(`  variants  ${specs.variants.length ? specs.variants.join(", ") : "none detected"}`);
  ctx.log(`  keep      ${specs.keep.length} entr${specs.keep.length === 1 ? "y" : "ies"}`);
  ctx.log("");
  ctx.log("next: relabeld apply --brand brand.yaml --dry-run");
  return 0;
}
