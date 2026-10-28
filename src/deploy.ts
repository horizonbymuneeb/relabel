import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import type { BrandSpec, Ctx } from "./types.js";
import { exists, loadYamlFile, slugify } from "./util.js";

const execFileP = promisify(execFile);

export const DEFAULT_PORT = 3000;
export const DEFAULT_BRAND_FILE = "brand.yaml";
export const DEFAULT_NGINX_DIR = "/etc/nginx/sites-available";
export const DEFAULT_NGINX_ENABLED_DIR = "/etc/nginx/sites-enabled";
export const DEFAULT_LOG_DIR = "/var/log/nginx";
export const DEFAULT_UPSTREAM_HOST = "127.0.0.1";

const USAGE = [
  "relabeld deploy — nginx vhost + optional Cloudflare A record (opt-in).",
  "",
  "Usage:",
  "  relabeld deploy [dir] --brand <brand.yaml> --dry-run [--port N]",
  "  relabeld deploy [dir] --brand <brand.yaml> --apply  [--port N] [--certbot]",
  "",
  "Mode (exactly one is required):",
  "  --dry-run        render and print the vhost + commands; writes and executes nothing",
  "  --apply          create the vhost, enable it and reload nginx (idempotent)",
  "",
  "Options:",
  "  --brand <file>   brand spec with a `domain` (default: brand.yaml in cwd or [dir])",
  "  --port <n>       upstream port on 127.0.0.1 (default: 3000)",
  "  --certbot        with --apply, also run the printed certbot command (issues TLS)",
  "  -h, --help       show this help",
  "",
  "Environment:",
  "  CF_DNS_ADMIN_TOKEN, CF_ZONE_ID, CF_ZONE_NAME   create the Cloudflare A record (never deletes)",
  "  CF_DNS_IP                                      override the detected public IPv4",
  "  RELABLE_NGINX_DIR, RELABLE_NGINX_ENABLED_DIR   override nginx target paths",
].join("\n");

export type StepStatus = "planned" | "done" | "unchanged" | "skipped" | "failed";

export interface DeployStep {
  id: string;
  status: StepStatus;
  detail: string;
}

export interface DeployArgs {
  dir: string;
  brand?: string;
  dryRun: boolean;
  apply: boolean;
  port: number;
  certbot: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; args: DeployArgs } | { ok: false; error: string };

export interface VhostOptions {
  domain: string;
  port?: number;
  brandName?: string;
  upstreamHost?: string;
  logDir?: string;
}

export interface CertbotOptions {
  domain: string;
  email?: string;
}

export interface CloudflareDnsOptions {
  domain: string;
  ip: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string;
}

export interface CloudflareDnsPayload {
  type: "A";
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string;
}

export interface DeployResult {
  command: "deploy";
  ok: boolean;
  mode: "dry-run" | "apply";
  dir: string;
  brand: { path: string; name: string; domain: string };
  port: number;
  nginx: { path: string; enabledPath: string; content: string; changed: boolean };
  certbot: { command: string; executed: boolean; status: StepStatus };
  dns: {
    status: "skipped" | "planned" | "created" | "exists" | "conflict" | "failed";
    reason?: string;
    payload?: CloudflareDnsPayload;
  };
  steps: DeployStep[];
  commands: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Pure template functions (unit tested; no I/O, no clock, no environment)
// ---------------------------------------------------------------------------

export function parseDeployArgs(argv: string[]): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        cwd: { type: "string" },
        brand: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        port: { type: "string" },
        certbot: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }

  const values = parsed.values as {
    brand?: string;
    "dry-run"?: boolean;
    apply?: boolean;
    port?: string;
    certbot?: boolean;
    help?: boolean;
  };
  const positionals = parsed.positionals as string[];

  if (values.help) {
    return {
      ok: true,
      args: { dir: positionals[0] ?? ".", brand: values.brand, dryRun: false, apply: false, port: DEFAULT_PORT, certbot: false, help: true },
    };
  }
  if (positionals.length > 1) {
    return { ok: false, error: `unexpected extra arguments: ${positionals.slice(1).join(" ")}` };
  }
  const dryRun = Boolean(values["dry-run"]);
  const apply = Boolean(values.apply);
  if (dryRun && apply) {
    return { ok: false, error: "--dry-run and --apply are mutually exclusive" };
  }
  if (!dryRun && !apply) {
    return { ok: false, error: "one of --dry-run or --apply is required (refusing to touch the system without an explicit mode)" };
  }
  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `invalid --port ${JSON.stringify(values.port)} (expected an integer 1-65535)` };
    }
  }
  return {
    ok: true,
    args: {
      dir: positionals[0] ?? ".",
      brand: values.brand,
      dryRun,
      apply,
      port,
      certbot: Boolean(values.certbot),
      help: false,
    },
  };
}

/** Validate the parts of a brand spec that deploy needs. Pure. */
export function parseBrandSpec(
  raw: unknown,
  file = "brand.yaml",
): { ok: true; brand: { name: string; domain: string; emailFrom?: string } } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${file}: expected a YAML mapping with at least name + domain` };
  }
  const spec = raw as Partial<BrandSpec>;
  if (typeof spec.name !== "string" || spec.name.trim() === "") {
    return { ok: false, error: `${file}: missing required field \`name\`` };
  }
  if (typeof spec.domain !== "string" || spec.domain.trim() === "") {
    return { ok: false, error: `${file}: missing required field \`domain\` (needed for server_name)` };
  }
  const domain = spec.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/i.test(domain)) {
    return { ok: false, error: `${file}: \`domain: ${spec.domain}\` is not a bare hostname (expected e.g. status.example.com)` };
  }
  const emailFrom = typeof spec.emailFrom === "string" ? spec.emailFrom : undefined;
  return { ok: true, brand: { name: spec.name.trim(), domain, emailFrom } };
}

export function nginxConfigPath(domain: string, dir: string = DEFAULT_NGINX_DIR): string {
  return path.posix.join(dir, `${domain}.conf`);
}

export function nginxEnabledPath(domain: string, dir: string = DEFAULT_NGINX_ENABLED_DIR): string {
  return path.posix.join(dir, `${domain}.conf`);
}

/** Render a deterministic nginx vhost. Same input -> byte-identical output. */
export function renderVhost(opts: VhostOptions): string {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const logs = opts.logDir ?? DEFAULT_LOG_DIR;
  const domain = opts.domain;
  const brand = opts.brandName ? ` (${opts.brandName})` : "";
  const slug = slugify(domain) || "site";
  return [
    `# relabeld — nginx vhost for ${domain}${brand}`,
    "# Generated by `relabeld deploy`; safe to re-run (idempotent).",
    "# TLS is provisioned by certbot (see the command printed by relabeld).",
    "",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${domain};`,
    "",
    `    access_log ${logs}/${domain}.access.log;`,
    `    error_log ${logs}/${domain}.error.log warn;`,
    "",
    "    # --- TLS placeholders: certbot --nginx fills these in ---------------",
    "    # listen 443 ssl http2;",
    "    # listen [::]:443 ssl http2;",
    `    # ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;`,
    `    # ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`,
    "    # include /etc/letsencrypt/options-ssl-nginx.conf;",
    "    # ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;",
    "    # --------------------------------------------------------------------",
    "",
    "    location / {",
    `        proxy_pass http://${host}:${port};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Upgrade $http_upgrade;",
    '        proxy_set_header Connection "upgrade";',
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_read_timeout 3600s;",
    "        proxy_send_timeout 3600s;",
    "        proxy_buffering off;",
    "    }",
    "}",
    "",
    `# upstream service: ${slug} on ${host}:${port}`,
    "",
  ].join("\n");
}

export function certbotEmail(emailFrom?: string): string | undefined {
  if (!emailFrom) return undefined;
  const angled = emailFrom.match(/<([^>]+)>/);
  if (angled && angled[1].includes("@")) return angled[1].trim();
  const bare = emailFrom.match(/[^\s,;<>]+@[^\s,;<>]+/);
  return bare ? bare[0] : undefined;
}

/** The exact certbot command a human should run after `--apply`. Pure. */
export function renderCertbotCommand(opts: CertbotOptions): string {
  const parts = ["certbot", "--nginx", "-d", opts.domain, "--non-interactive", "--agree-tos"];
  const email = certbotEmail(opts.email);
  if (email) parts.push("-m", email);
  else parts.push("--register-unsafely-without-email");
  return parts.join(" ");
}

/**
 * JSON body for `POST /zones/:zone/dns_records`. Create-only by design:
 * it contains no record id and no delete/update semantics.
 */
export function buildCloudflareDnsPayload(opts: CloudflareDnsOptions): CloudflareDnsPayload {
  const ip = opts.ip.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`invalid IPv4 address for Cloudflare A record: ${JSON.stringify(opts.ip)}`);
  }
  return {
    type: "A",
    name: opts.domain,
    content: ip,
    proxied: opts.proxied ?? true,
    ttl: opts.ttl ?? 1,
    comment: opts.comment ?? "managed by relabeld deploy",
  };
}

// ---------------------------------------------------------------------------
// Side-effect helpers (only reached in --apply mode, or read-only IP lookup)
// ---------------------------------------------------------------------------

interface ExecOutcome {
  ok: boolean;
  missing: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(cmd: string, args: string[]): Promise<ExecOutcome> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 60_000 });
    return { ok: true, missing: false, code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      missing: e.code === "ENOENT",
      code: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

export async function detectPublicIp(timeoutMs = 3000): Promise<string | null> {
  const endpoints = ["https://api.ipify.org", "https://ifconfig.me/ip"];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

interface NginxApplyOutcome {
  steps: DeployStep[];
  changed: boolean;
  error?: string;
}

async function applyNginx(opts: {
  configPath: string;
  enabledPath: string;
  content: string;
  configDir: string;
  enabledDir: string;
  runChecks: boolean;
}): Promise<NginxApplyOutcome> {
  const steps: DeployStep[] = [];
  let changed = false;
  try {
    await mkdir(opts.configDir, { recursive: true });
    let existing: string | null = null;
    if (existsSync(opts.configPath)) {
      try {
        existing = await readFile(opts.configPath, "utf8");
      } catch {
        existing = null;
      }
    }
    if (existing === opts.content) {
      steps.push({ id: "nginx:vhost", status: "unchanged", detail: `${opts.configPath} already up to date` });
    } else {
      await writeFile(opts.configPath, opts.content, "utf8");
      changed = true;
      steps.push({
        id: "nginx:vhost",
        status: "done",
        detail: `${existing === null ? "created" : "updated"} ${opts.configPath}`,
      });
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      steps: [
        ...steps,
        { id: "nginx:vhost", status: "failed", detail: `cannot write ${opts.configPath}: ${e.message}` },
      ],
      changed,
      error: `cannot write ${opts.configPath}: ${e.message} — re-run with sudo or set RELABLE_NGINX_DIR`,
    };
  }

  // Enable the site: symlink sites-enabled/<domain>.conf -> sites-available/<domain>.conf
  try {
    await mkdir(opts.enabledDir, { recursive: true });
    let linkIsCorrect = false;
    let linkExists = false;
    try {
      const st = await lstat(opts.enabledPath);
      linkExists = true;
      if (st.isSymbolicLink()) {
        const target = await readlink(opts.enabledPath);
        const resolved = path.resolve(path.dirname(opts.enabledPath), target);
        linkIsCorrect = resolved === path.resolve(opts.configPath);
      }
    } catch {
      linkExists = false;
    }
    if (linkIsCorrect) {
      steps.push({ id: "nginx:enable", status: "unchanged", detail: `${opts.enabledPath} already linked` });
    } else if (linkExists) {
      steps.push({
        id: "nginx:enable",
        status: "skipped",
        detail: `${opts.enabledPath} exists but is not a symlink to the generated vhost; left untouched`,
      });
    } else {
      await symlink(opts.configPath, opts.enabledPath);
      changed = true;
      steps.push({ id: "nginx:enable", status: "done", detail: `linked ${opts.enabledPath} -> ${opts.configPath}` });
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      steps: [...steps, { id: "nginx:enable", status: "failed", detail: `cannot enable site: ${e.message}` }],
      changed,
      error: `cannot create symlink ${opts.enabledPath}: ${e.message} — re-run with sudo`,
    };
  }

  if (!changed) {
    steps.push({ id: "nginx:reload", status: "unchanged", detail: "config already current; reload not needed" });
    return { steps, changed };
  }
  if (!opts.runChecks) {
    steps.push({ id: "nginx:reload", status: "skipped", detail: "custom nginx directory; skipped nginx -t / systemctl reload" });
    return { steps, changed };
  }
  const test = await exec("nginx", ["-t"]);
  if (test.missing) {
    steps.push({ id: "nginx:test", status: "skipped", detail: "nginx binary not found on PATH" });
  } else if (!test.ok) {
    return {
      steps: [...steps, { id: "nginx:test", status: "failed", detail: (test.stderr || test.stdout).trim().slice(0, 800) }],
      changed,
      error: "`nginx -t` rejected the configuration; reload skipped",
    };
  } else {
    steps.push({ id: "nginx:test", status: "done", detail: "nginx -t ok" });
  }
  const reload = await exec("systemctl", ["reload", "nginx"]);
  if (reload.missing) {
    const fallback = await exec("nginx", ["-s", "reload"]);
    if (fallback.missing || !fallback.ok) {
      steps.push({
        id: "nginx:reload",
        status: fallback.missing ? "skipped" : "failed",
        detail: fallback.missing ? "neither systemctl nor nginx found; reload manually" : (fallback.stderr || "").slice(0, 400),
      });
    } else {
      steps.push({ id: "nginx:reload", status: "done", detail: "nginx -s reload" });
    }
  } else if (!reload.ok) {
    steps.push({ id: "nginx:reload", status: "failed", detail: (reload.stderr || "").trim().slice(0, 400) });
  } else {
    steps.push({ id: "nginx:reload", status: "done", detail: "systemctl reload nginx" });
  }
  return { steps, changed };
}

interface DnsOutcome {
  dns: DeployResult["dns"];
  step: DeployStep;
}

async function applyCloudflare(opts: {
  zoneId: string;
  zoneName?: string;
  token: string;
  payload: CloudflareDnsPayload;
}): Promise<DnsOutcome> {
  const base = "https://api.cloudflare.com/client/v4";
  const headers = {
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/json",
  };
  const q = new URLSearchParams({ type: "A", name: opts.payload.name });
  let existing: Array<{ id: string; content: string }> = [];
  try {
    const res = await fetch(`${base}/zones/${encodeURIComponent(opts.zoneId)}/dns_records?${q}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { success?: boolean; result?: Array<{ id: string; content: string }>; errors?: unknown };
    if (!res.ok || body.success === false) {
      return {
        dns: { status: "failed", reason: `cloudflare list failed: ${JSON.stringify(body.errors ?? body).slice(0, 500)}` },
        step: { id: "cloudflare:dns", status: "failed", detail: "could not list existing A records" },
      };
    }
    existing = body.result ?? [];
  } catch (err) {
    return {
      dns: { status: "failed", reason: `cloudflare list failed: ${(err as Error).message}` },
      step: { id: "cloudflare:dns", status: "failed", detail: "network error listing records" },
    };
  }

  if (existing.length > 0) {
    const same = existing.every((r) => r.content === opts.payload.content);
    if (same) {
      return {
        dns: { status: "exists", reason: `A ${opts.payload.name} already points at ${opts.payload.content}`, payload: opts.payload },
        step: { id: "cloudflare:dns", status: "unchanged", detail: `A record exists -> ${opts.payload.content}` },
      };
    }
    return {
      dns: {
        status: "conflict",
        reason: `A ${opts.payload.name} already exists with a different target (${existing.map((r) => r.content).join(", ")}); relabeld never deletes or rewrites DNS`,
        payload: opts.payload,
      },
      step: { id: "cloudflare:dns", status: "failed", detail: "conflicting A record; left untouched" },
    };
  }

  try {
    const res = await fetch(`${base}/zones/${encodeURIComponent(opts.zoneId)}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { success?: boolean; errors?: unknown };
    if (!res.ok || body.success === false) {
      return {
        dns: { status: "failed", reason: `cloudflare create failed: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`, payload: opts.payload },
        step: { id: "cloudflare:dns", status: "failed", detail: "create request rejected" },
      };
    }
    return {
      dns: { status: "created", payload: opts.payload },
      step: { id: "cloudflare:dns", status: "done", detail: `created A ${opts.payload.name} -> ${opts.payload.content}` },
    };
  } catch (err) {
    return {
      dns: { status: "failed", reason: `cloudflare create failed: ${(err as Error).message}`, payload: opts.payload },
      step: { id: "cloudflare:dns", status: "failed", detail: "network error creating record" },
    };
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emitError(ctx: Ctx, error: string, exitCode: number): number {
  if (ctx.json) {
    ctx.log(JSON.stringify({ command: "deploy", ok: false, error, exitCode }, null, 2));
  } else {
    ctx.error(`deploy: ${error}`);
  }
  return exitCode;
}

function humanReport(result: DeployResult, ctx: Ctx): void {
  const mode = result.mode === "dry-run" ? "dry-run — nothing written, nothing executed" : "apply";
  ctx.log(`relabel deploy — ${result.brand.name} (${result.brand.domain})`);
  ctx.log(`mode: ${mode}`);
  ctx.log(`app dir: ${result.dir}`);
  ctx.log(`upstream: http://${DEFAULT_UPSTREAM_HOST}:${result.port}`);
  ctx.log(`nginx: ${result.nginx.path}${result.nginx.changed ? " (will change)" : " (up to date)"}`);
  ctx.log("");
  ctx.log(`--- ${result.nginx.path} ---`);
  ctx.log(result.nginx.content.replace(/\n$/, ""));
  ctx.log("--- end nginx vhost ---");
  ctx.log("");
  for (const step of result.steps) {
    ctx.log(`step ${step.status.padEnd(9)} ${step.id}: ${step.detail}`);
  }
  if (result.dns.status === "skipped") ctx.log(`cloudflare dns: skipped (${result.dns.reason ?? "not configured"})`);
  else if (result.dns.payload) ctx.log(`cloudflare dns payload: ${JSON.stringify(result.dns.payload)}`);
  ctx.log("");
  ctx.log("commands:");
  for (const cmd of result.commands) ctx.log(`  ${cmd}`);
  if (result.notes.length > 0) {
    ctx.log("");
    for (const note of result.notes) ctx.log(`note: ${note}`);
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

async function resolveBrandFile(brandArg: string | undefined, ctx: Ctx, dir: string): Promise<string | null> {
  const candidates: string[] = [];
  if (brandArg) {
    candidates.push(path.resolve(ctx.cwd, brandArg));
    candidates.push(path.resolve(dir, brandArg));
  } else {
    candidates.push(path.resolve(ctx.cwd, DEFAULT_BRAND_FILE));
    candidates.push(path.resolve(dir, DEFAULT_BRAND_FILE));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const parsed = parseDeployArgs(argv);
  if (!parsed.ok) return emitError(ctx, parsed.error, 2);
  const args = parsed.args;
  if (args.help) {
    ctx.log(USAGE);
    return 0;
  }

  const dir = path.resolve(ctx.cwd, args.dir);
  if (!exists(dir)) return emitError(ctx, `app dir not found: ${dir}`, 1);

  const brandPath = await resolveBrandFile(args.brand, ctx, dir);
  if (!brandPath) {
    return emitError(ctx, `brand spec not found${args.brand ? `: ${args.brand}` : ` (${DEFAULT_BRAND_FILE})`}`, 1);
  }
  let rawBrand: unknown;
  try {
    rawBrand = await loadYamlFile<unknown>(brandPath);
  } catch (err) {
    return emitError(ctx, `cannot read brand spec ${brandPath}: ${(err as Error).message}`, 1);
  }
  const spec = parseBrandSpec(rawBrand, brandPath);
  if (!spec.ok) return emitError(ctx, spec.error, 1);
  const brand = spec.brand;

  const configDir = process.env.RELABLE_NGINX_DIR || DEFAULT_NGINX_DIR;
  const enabledDir = process.env.RELABLE_NGINX_ENABLED_DIR || DEFAULT_NGINX_ENABLED_DIR;
  const configPath = nginxConfigPath(brand.domain, configDir);
  const enabledPath = nginxEnabledPath(brand.domain, enabledDir);
  const content = renderVhost({ domain: brand.domain, port: args.port, brandName: brand.name });
  const certbotCommand = renderCertbotCommand({ domain: brand.domain, email: certbotEmail(brand.emailFrom) });

  const steps: DeployStep[] = [];
  const commands: string[] = [];
  const notes: string[] = [];
  const result: DeployResult = {
    command: "deploy",
    ok: true,
    mode: args.dryRun ? "dry-run" : "apply",
    dir,
    brand: { path: brandPath, name: brand.name, domain: brand.domain },
    port: args.port,
    nginx: { path: configPath, enabledPath, content, changed: false },
    certbot: { command: certbotCommand, executed: false, status: args.certbot ? "planned" : "skipped" },
    dns: { status: "skipped" },
    steps,
    commands,
    notes,
  };

  // Cloudflare: plan the create-only payload before doing any work.
  const cfToken = process.env.CF_DNS_ADMIN_TOKEN;
  const zoneId = process.env.CF_ZONE_ID;
  const zoneName = process.env.CF_ZONE_NAME;
  let cfPayload: CloudflareDnsPayload | undefined;
  if (!cfToken || !zoneId || !zoneName) {
    const missing = [
      !cfToken ? "CF_DNS_ADMIN_TOKEN" : "",
      !zoneId ? "CF_ZONE_ID" : "",
      !zoneName ? "CF_ZONE_NAME" : "",
    ].filter(Boolean);
    result.dns = { status: "skipped", reason: `${missing.join(", ")} not set` };
  } else {
    const ip = process.env.CF_DNS_IP || (await detectPublicIp());
    if (!ip) {
      result.dns = { status: "skipped", reason: "could not detect public IPv4; set CF_DNS_IP" };
    } else {
      try {
        cfPayload = buildCloudflareDnsPayload({ domain: brand.domain, ip });
      } catch (err) {
        return emitError(ctx, (err as Error).message, 1);
      }
    }
  }

  commands.push(`sudo mkdir -p ${configDir} ${enabledDir}`);
  commands.push(`# write ${configPath} (relabeld --apply does this)`);
  commands.push(`sudo ln -sfn ${configPath} ${enabledPath}`);
  commands.push("sudo nginx -t && sudo systemctl reload nginx");
  commands.push(`sudo ${certbotCommand}`);
  if (cfPayload) {
    commands.push(
      `curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" ` +
        `-H "Authorization: Bearer $CF_DNS_ADMIN_TOKEN" -H "Content-Type: application/json" ` +
        `--data '${JSON.stringify(cfPayload)}'`,
    );
  }

  if (args.dryRun) {
    result.nginx.changed = true;
    steps.push({ id: "nginx:vhost", status: "planned", detail: `would write ${configPath}` });
    steps.push({ id: "nginx:enable", status: "planned", detail: `would link ${enabledPath} -> ${configPath}` });
    steps.push({ id: "nginx:reload", status: "planned", detail: "would run nginx -t && systemctl reload nginx" });
    steps.push({ id: "certbot", status: args.certbot ? "planned" : "skipped", detail: certbotCommand });
    if (cfPayload) result.dns = { status: "planned", payload: cfPayload };
    result.steps = steps;
    if (ctx.json) ctx.log(JSON.stringify(result, null, 2));
    else humanReport(result, ctx);
    return 0;
  }

  // --apply: the only path that touches the system.
  const nginx = await applyNginx({
    configPath,
    enabledPath,
    content,
    configDir,
    enabledDir,
    runChecks: configDir === DEFAULT_NGINX_DIR || enabledDir === DEFAULT_NGINX_ENABLED_DIR,
  });
  result.nginx.changed = nginx.changed;
  steps.push(...nginx.steps);
  if (nginx.error) {
    result.ok = false;
    result.steps = steps;
    if (ctx.json) ctx.log(JSON.stringify(result, null, 2));
    else humanReport(result, ctx);
    return 1;
  }

  if (cfPayload) {
    const dns = await applyCloudflare({ zoneId: zoneId as string, zoneName, token: cfToken as string, payload: cfPayload });
    result.dns = dns.dns;
    steps.push(dns.step);
    if (dns.dns.status === "failed" || dns.dns.status === "conflict") result.ok = false;
  }

  if (args.certbot) {
    const email = certbotEmail(brand.emailFrom);
    const certArgs = ["--nginx", "-d", brand.domain, "--non-interactive", "--agree-tos"];
    if (email) certArgs.push("-m", email);
    else certArgs.push("--register-unsafely-without-email");
    const runCertbot = await exec("certbot", certArgs);
    result.certbot.executed = true;
    if (runCertbot.missing) {
      result.certbot.status = "skipped";
      steps.push({ id: "certbot", status: "skipped", detail: "certbot not installed" });
      notes.push("install certbot (apt-get install certbot python3-certbot-nginx) to issue TLS");
    } else if (!runCertbot.ok) {
      result.certbot.status = "failed";
      result.ok = false;
      steps.push({ id: "certbot", status: "failed", detail: (runCertbot.stderr || "").trim().slice(0, 800) });
    } else {
      result.certbot.status = "done";
      steps.push({ id: "certbot", status: "done", detail: "certbot issued/renewed the certificate" });
      const reload = await exec("systemctl", ["reload", "nginx"]);
      if (!reload.ok && !reload.missing) notes.push("certificate issued but nginx reload failed; run `systemctl reload nginx`");
    }
  } else {
    steps.push({ id: "certbot", status: "skipped", detail: `run manually: sudo ${certbotCommand}` });
  }

  result.steps = steps;
  if (ctx.json) ctx.log(JSON.stringify(result, null, 2));
  else humanReport(result, ctx);
  return result.ok ? 0 : 1;
}
