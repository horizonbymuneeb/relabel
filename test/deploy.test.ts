import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  DEFAULT_PORT,
  buildCloudflareDnsPayload,
  certbotEmail,
  hasControlChars,
  isCertbotManagedVhost,
  nginxConfigPath,
  nginxEnabledPath,
  parseBrandSpec,
  parseDeployArgs,
  renderCertbotCommand,
  renderVhost,
  run,
  sanitizeNginxComment,
  timestampedBackupPath,
} from "../dist/deploy.js";
import type { Ctx } from "../dist/types.js";

const BRAND_YAML = [
  "name: Nova Status",
  "domain: status.nova.example",
  "palette:",
  '  primary: "#0f172a"',
  'emailFrom: "Nova Status <ops@nova.example>"',
  "variants: [light, dark]",
  "keep: [uptime-kuma]",
  "",
].join("\n");

interface Captured {
  ctx: Ctx;
  out: string[];
  errs: string[];
}

function makeCtx(cwd: string, json = false): Captured {
  const out: string[] = [];
  const errs: string[] = [];
  const ctx: Ctx = {
    cwd,
    json,
    log: (msg: string) => out.push(msg),
    error: (msg: string) => errs.push(msg),
    version: "0.0.0-test",
  };
  return { ctx, out, errs };
}

async function tempRoot(): Promise<{ root: string; app: string; brand: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "relabel-deploy-"));
  const app = path.join(root, "app");
  await mkdir(app, { recursive: true });
  const brand = path.join(root, "brand.yaml");
  await writeFile(brand, BRAND_YAML, "utf8");
  return { root, app, brand };
}

const NESTED_ENV = [
  "RELABEL_NGINX_DIR",
  "RELABEL_NGINX_ENABLED_DIR",
  "CF_DNS_ADMIN_TOKEN",
  "CF_ZONE_ID",
  "CF_ZONE_NAME",
  "CF_DNS_IP",
] as const;

async function withEnv<T>(overrides: Partial<Record<(typeof NESTED_ENV)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of NESTED_ENV) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of NESTED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Pure: argument parsing
// ---------------------------------------------------------------------------

test("parseDeployArgs: dry-run defaults", () => {
  const parsed = parseDeployArgs(["--dry-run"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.args.dir, ".");
  assert.equal(parsed.args.dryRun, true);
  assert.equal(parsed.args.apply, false);
  assert.equal(parsed.args.port, DEFAULT_PORT);
});

test("parseDeployArgs: positional dir, brand and port", () => {
  const parsed = parseDeployArgs(["/srv/app", "--brand", "brand.yaml", "--apply", "--port", "8080"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.args.dir, "/srv/app");
  assert.equal(parsed.args.brand, "brand.yaml");
  assert.equal(parsed.args.apply, true);
  assert.equal(parsed.args.port, 8080);
});

test("parseDeployArgs: rejects missing mode, both modes, bad port and unknown flags", () => {
  const noMode = parseDeployArgs(["--brand", "brand.yaml"]);
  assert.equal(noMode.ok, false);
  if (!noMode.ok) assert.match(noMode.error, /--dry-run or --apply/);

  const both = parseDeployArgs(["--dry-run", "--apply"]);
  assert.equal(both.ok, false);

  const badPort = parseDeployArgs(["--dry-run", "--port", "0"]);
  assert.equal(badPort.ok, false);
  if (!badPort.ok) assert.match(badPort.error, /invalid --port/);

  const unknown = parseDeployArgs(["--dry-run", "--bogus"]);
  assert.equal(unknown.ok, false);

  const extra = parseDeployArgs(["--dry-run", "a", "b"]);
  assert.equal(extra.ok, false);
});

test("parseDeployArgs: help short-circuits", () => {
  const parsed = parseDeployArgs(["--help"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.args.help, true);
});

// ---------------------------------------------------------------------------
// Pure: brand spec validation
// ---------------------------------------------------------------------------

test("parseBrandSpec: valid spec is normalized", () => {
  const parsed = parseBrandSpec({ name: "Nova Status", domain: "HTTPS://Status.Nova.Example/", emailFrom: "Ops <ops@nova.example>" }, "brand.yaml");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.brand.name, "Nova Status");
  assert.equal(parsed.brand.domain, "status.nova.example");
  assert.equal(parsed.brand.emailFrom, "Ops <ops@nova.example>");
});

test("parseBrandSpec: rejects missing name/domain and non-hostname domains", () => {
  assert.equal(parseBrandSpec({ domain: "a.example" }).ok, false);
  const noDomain = parseBrandSpec({ name: "Nova" });
  assert.equal(noDomain.ok, false);
  if (!noDomain.ok) assert.match(noDomain.error, /missing required field `domain`/);
  assert.equal(parseBrandSpec({ name: "Nova", domain: "localhost" }).ok, false);
  assert.equal(parseBrandSpec({ name: "Nova", domain: "https://" }).ok, false);
  assert.equal(parseBrandSpec("nope").ok, false);
  assert.equal(parseBrandSpec(null).ok, false);
});

// ---------------------------------------------------------------------------
// Pure: nginx template
// ---------------------------------------------------------------------------

test("renderVhost: domain, proxy_pass, websocket headers, logs and TLS placeholders", () => {
  const vhost = renderVhost({ domain: "status.nova.example", port: 4321, brandName: "Nova Status" });
  assert.match(vhost, /server_name status\.nova\.example;/);
  assert.match(vhost, /proxy_pass http:\/\/127\.0\.0\.1:4321;/);
  assert.match(vhost, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(vhost, /proxy_set_header Connection "upgrade";/);
  assert.match(vhost, /access_log \/var\/log\/nginx\/status\.nova\.example\.access\.log;/);
  assert.match(vhost, /error_log \/var\/log\/nginx\/status\.nova\.example\.error\.log warn;/);
  // TLS is placeholder-only until certbot runs.
  assert.match(vhost, /# listen 443 ssl http2;/);
  assert.match(vhost, /# ssl_certificate\s+\/etc\/letsencrypt\/live\/status\.nova\.example\/fullchain\.pem;/);
  assert.match(vhost, /# ssl_certificate_key \/etc\/letsencrypt\/live\/status\.nova\.example\/privkey\.pem;/);
  assert.match(vhost, /Nova Status/);
  // Balanced braces: one server block.
  assert.equal((vhost.match(/\{/g) ?? []).length, (vhost.match(/\}/g) ?? []).length);
  assert.equal((vhost.match(/server \{/g) ?? []).length, 1);
});

test("renderVhost: deterministic and port/upstream/log overridable", () => {
  const a = renderVhost({ domain: "a.example.org", port: 3000 });
  const b = renderVhost({ domain: "a.example.org", port: 3000 });
  assert.equal(a, b);
  assert.match(a, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  const custom = renderVhost({ domain: "a.example.org", port: 9000, upstreamHost: "10.0.0.5", logDir: "/tmp/logs" });
  assert.match(custom, /proxy_pass http:\/\/10\.0\.0\.5:9000;/);
  assert.match(custom, /access_log \/tmp\/logs\/a\.example\.org\.access\.log;/);
});

test("renderVhost: contains no credentials or tokens", () => {
  const vhost = renderVhost({ domain: "status.nova.example", port: 3000, brandName: "Nova Status" });
  assert.doesNotMatch(vhost, /bearer|token|password|secret|CF_DNS/i);
});

test("nginx paths derive from the domain", () => {
  assert.equal(nginxConfigPath("a.example.org"), "/etc/nginx/sites-available/a.example.org.conf");
  assert.equal(nginxEnabledPath("a.example.org"), "/etc/nginx/sites-enabled/a.example.org.conf");
  assert.equal(nginxConfigPath("a.example.org", "/tmp/relabel-nginx"), "/tmp/relabel-nginx/a.example.org.conf");
});

// ---------------------------------------------------------------------------
// Pure: certbot + Cloudflare payloads
// ---------------------------------------------------------------------------

test("renderCertbotCommand: uses brand email when available", () => {
  const withEmail = renderCertbotCommand({ domain: "a.example.org", email: "Ops <ops@a.example.org>" });
  assert.equal(withEmail, "certbot --nginx -d a.example.org --non-interactive --agree-tos -m ops@a.example.org");
  const noEmail = renderCertbotCommand({ domain: "a.example.org" });
  assert.match(noEmail, /--register-unsafely-without-email/);
  assert.doesNotMatch(noEmail, /-m /);
});

test("certbotEmail extracts addresses, ignores junk", () => {
  assert.equal(certbotEmail("Nova <ops@nova.example>"), "ops@nova.example");
  assert.equal(certbotEmail("ops@nova.example"), "ops@nova.example");
  assert.equal(certbotEmail("Nova Status"), undefined);
  assert.equal(certbotEmail(undefined), undefined);
});

test("buildCloudflareDnsPayload: create-only A record, never a delete", () => {
  const payload = buildCloudflareDnsPayload({ domain: "status.nova.example", ip: "203.0.113.10" });
  assert.deepEqual(payload, {
    type: "A",
    name: "status.nova.example",
    content: "203.0.113.10",
    proxied: true,
    ttl: 1,
    comment: "managed by relabeld deploy",
  });
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /delete|PATCH|PUT/i);
  assert.equal("id" in payload, false);

  const proxied = buildCloudflareDnsPayload({ domain: "a.example.org", ip: "203.0.113.11", proxied: false, ttl: 300 });
  assert.equal(proxied.proxied, false);
  assert.equal(proxied.ttl, 300);

  assert.throws(() => buildCloudflareDnsPayload({ domain: "a.example.org", ip: "not-an-ip" }), /invalid IPv4/);
});

// ---------------------------------------------------------------------------
// run(): dry-run writes nothing
// ---------------------------------------------------------------------------

test("run --dry-run: renders vhost, prints commands, writes nothing", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  const enabledDir = path.join(root, "enabled");
  try {
    const { ctx, out } = makeCtx(root, false);
    const code = await withEnv({ RELABEL_NGINX_DIR: nginxDir, RELABEL_NGINX_ENABLED_DIR: enabledDir }, () =>
      run([app, "--brand", brand, "--dry-run", "--port", "8123"], ctx),
    );
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /mode: dry-run/);
    assert.match(text, /server_name status\.nova\.example;/);
    assert.match(text, /proxy_pass http:\/\/127\.0\.0\.1:8123;/);
    assert.match(text, /certbot --nginx -d status\.nova\.example/);
    assert.match(text, /cloudflare dns: skipped/);
    // Nothing written, even to the overridden nginx dir.
    await assert.rejects(stat(nginxDir), /ENOENT/);
    await assert.rejects(stat(path.join(nginxDir, "status.nova.example.conf")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run --dry-run --json: exactly one JSON object", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  try {
    const { ctx, out, errs } = makeCtx(root, true);
    const code = await withEnv({ RELABEL_NGINX_DIR: nginxDir }, () =>
      run(["--dry-run", "--json", app, "--brand", brand], ctx),
    );
    assert.equal(code, 0);
    assert.equal(out.length, 1, "JSON mode must emit exactly one object");
    const parsed = JSON.parse(out[0]) as Record<string, any>;
    assert.equal(parsed.command, "deploy");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "dry-run");
    assert.equal(parsed.brand.domain, "status.nova.example");
    assert.equal(parsed.port, 3000);
    assert.equal(parsed.dns.status, "skipped");
    assert.ok(parsed.nginx.content.includes("proxy_pass http://127.0.0.1:3000;"));
    assert.ok(Array.isArray(parsed.commands));
    assert.equal(errs.length, 0);
    await assert.rejects(stat(path.join(nginxDir, "status.nova.example.conf")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run --dry-run: never touches the default system nginx paths", async () => {
  const { root, app } = await tempRoot();
  const domain = `relabel-${Date.now()}.test.invalid`;
  const brandFile = path.join(root, "system-brand.yaml");
  await writeFile(brandFile, `name: System Probe\ndomain: ${domain}\n`, "utf8");
  const systemPath = nginxConfigPath(domain);
  try {
    const { ctx } = makeCtx(root, true);
    const code = await withEnv({}, () => run([app, "--brand", brandFile, "--dry-run", "--json"], ctx));
    assert.equal(code, 0);
    let exists = true;
    try {
      await stat(systemPath);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `${systemPath} must not be created by --dry-run`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// run(): --apply is gated and idempotent
// ---------------------------------------------------------------------------

test("run --apply: writes + enables the vhost; the second run is a no-op", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  const enabledDir = path.join(root, "enabled");
  const configPath = path.join(nginxDir, "status.nova.example.conf");
  const enabledPath = path.join(enabledDir, "status.nova.example.conf");
  const env = { RELABEL_NGINX_DIR: nginxDir, RELABEL_NGINX_ENABLED_DIR: enabledDir };
  try {
    const first = makeCtx(root, true);
    const firstCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--json"], first.ctx));
    assert.equal(firstCode, 0);
    const firstJson = JSON.parse(first.out[0]) as Record<string, any>;
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.nginx.changed, true);
    const written = await readFile(configPath, "utf8");
    assert.match(written, /server_name status\.nova\.example;/);
    assert.match(written, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    const linkTarget = await readlink(enabledPath);
    assert.equal(path.resolve(path.dirname(enabledPath), linkTarget), path.resolve(configPath));
    // Custom nginx dir: system commands are skipped, never executed.
    assert.equal(firstJson.steps.find((s: any) => s.id === "nginx:reload").status, "skipped");

    const second = makeCtx(root, true);
    const secondCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--json"], second.ctx));
    assert.equal(secondCode, 0);
    const secondJson = JSON.parse(second.out[0]) as Record<string, any>;
    assert.equal(secondJson.nginx.changed, false);
    const vhostStep = secondJson.steps.find((s: any) => s.id === "nginx:vhost");
    assert.equal(vhostStep.status, "unchanged");
    const enableStep = secondJson.steps.find((s: any) => s.id === "nginx:enable");
    assert.equal(enableStep.status, "unchanged");
    // Same bytes, no rewrite churn.
    assert.equal(await readFile(configPath, "utf8"), written);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run --apply: custom port propagates into the written vhost", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  try {
    const { ctx } = makeCtx(root, true);
    const code = await withEnv({ RELABEL_NGINX_DIR: nginxDir, RELABEL_NGINX_ENABLED_DIR: path.join(root, "enabled") }, () =>
      run([app, "--brand", brand, "--apply", "--port", "7001", "--json"], ctx),
    );
    assert.equal(code, 0);
    const written = await readFile(path.join(nginxDir, "status.nova.example.conf"), "utf8");
    assert.match(written, /proxy_pass http:\/\/127\.0\.0\.1:7001;/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// run(): errors and exit codes
// ---------------------------------------------------------------------------

test("run: missing brand exits 1", async () => {
  const { root, app } = await tempRoot();
  try {
    const { ctx, out } = makeCtx(root, true);
    const code = await run([app, "--brand", "does-not-exist.yaml", "--dry-run", "--json"], ctx);
    assert.equal(code, 1);
    const parsed = JSON.parse(out[0]) as Record<string, any>;
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /brand spec not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: brand without domain exits 1", async () => {
  const { root, app } = await tempRoot();
  const brand = path.join(root, "no-domain.yaml");
  await writeFile(brand, "name: No Domain\npalette:\n  primary: '#000000'\n", "utf8");
  try {
    const { ctx, out } = makeCtx(root, true);
    const code = await run([app, "--brand", brand, "--dry-run", "--json"], ctx);
    assert.equal(code, 1);
    const parsed = JSON.parse(out[0]) as Record<string, any>;
    assert.match(parsed.error, /domain/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: usage errors exit 2 with one JSON object", async () => {
  const { root } = await tempRoot();
  try {
    const { ctx, out } = makeCtx(root, true);
    const code = await run(["--apply", "--dry-run"], ctx);
    assert.equal(code, 2);
    assert.equal(out.length, 1);
    const parsed = JSON.parse(out[0]) as Record<string, any>;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: nonexistent app dir exits 1", async () => {
  const { root } = await tempRoot();
  try {
    const { ctx } = makeCtx(root, true);
    const code = await run([path.join(root, "nope"), "--brand", "brand.yaml", "--dry-run", "--json"], ctx);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run: --help prints usage and exits 0", async () => {
  const { root } = await tempRoot();
  try {
    const { ctx, out } = makeCtx(root, false);
    const code = await run(["--help"], ctx);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /relabeld deploy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseDeployArgs: --force is accepted and defaults to false", () => {
  const parsed = parseDeployArgs(["--apply", "--force"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.args.force, true);
  const plain = parseDeployArgs(["--apply"]);
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal(plain.args.force, false);
});

// ---------------------------------------------------------------------------
// B3: brand-spec injection (name -> nginx comment, email -> certbot shell)
// ---------------------------------------------------------------------------

test("B3: parseBrandSpec rejects control characters in name/domain/email", () => {
  const injectedName = { name: 'Nova Status\n    add_header X-Evil "1";', domain: "status.nova.example" };
  const badName = parseBrandSpec(injectedName);
  assert.equal(badName.ok, false);
  if (!badName.ok) assert.match(badName.error, /control characters/);

  const badDomain = parseBrandSpec({ name: "Nova", domain: "status.nova.example\n    add_header X 1;" });
  assert.equal(badDomain.ok, false);
  if (!badDomain.ok) assert.match(badDomain.error, /domain/);

  const badEmail = parseBrandSpec({ name: "Nova", domain: "status.nova.example", emailFrom: "ops@nova.example\ninjected" });
  assert.equal(badEmail.ok, false);
  if (!badEmail.ok) assert.match(badEmail.error, /emailFrom/);

  assert.equal(parseBrandSpec({ name: "Nova\tStatus", domain: "a.example.org" }).ok, false);
  assert.equal(parseBrandSpec({ name: "Nova\rStatus", domain: "a.example.org" }).ok, false);
});

test("B3: renderVhost keeps a newline-bearing brand name inside one comment line", () => {
  const evil = 'Nova Status\n    add_header X-Injected "1";';
  const vhost = renderVhost({ domain: "status.nova.example", port: 3000, brandName: evil });
  const lines = vhost.split("\n");
  const header = lines[0];
  assert.ok(header.startsWith("# relabeld — nginx vhost for status.nova.example"));
  assert.match(header, /Nova Status add_header X-Injected "1";/);
  assert.equal(lines.filter((line) => /^\s*add_header\b/.test(line)).length, 0);
  assert.equal(sanitizeNginxComment("a\nb\tc"), "a b c");
  assert.equal(sanitizeNginxComment("x".repeat(500)).length, 120);
  assert.equal(hasControlChars("plain text"), false);
  assert.equal(hasControlChars("a\nb"), true);
});

test("B3: renderVhost refuses injected domain/upstream/log values", () => {
  assert.throws(() => renderVhost({ domain: "status.nova.example\n    add_header X 1;", port: 3000 }), /invalid domain/);
  assert.throws(
    () => renderVhost({ domain: "status.nova.example", port: 3000, upstreamHost: "127.0.0.1; include /etc/passwd" }),
    /invalid upstream host/,
  );
  assert.throws(
    () => renderVhost({ domain: "status.nova.example", port: 3000, logDir: "/var/log/nginx\n  add_header X 1;" }),
    /invalid log dir/,
  );
  assert.throws(() => renderVhost({ domain: "status.nova.example", port: 0 }), /invalid port/);
});

test("B3: certbot email stays in a conservative charset", () => {
  assert.equal(certbotEmail("$(touch /tmp/pwn)@evil.example"), undefined);
  assert.equal(certbotEmail("`id`@evil.example"), undefined);
  assert.equal(certbotEmail("Nova Ops"), undefined);
  assert.equal(certbotEmail("ops@nova.example; rm -rf /"), "ops@nova.example");
  for (const email of [certbotEmail("a b@example.com"), certbotEmail("Nova <ops@nova.example>")]) {
    if (email) assert.match(email, /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/);
  }
  const cmd = renderCertbotCommand({ domain: "status.nova.example", email: "Nova <ops@nova.example>" });
  assert.match(cmd, /-m ops@nova\.example$/);
  assert.doesNotMatch(cmd, /[`$();'"]/);
  const hostile = renderCertbotCommand({ domain: "status.nova.example", email: "$(curl evil)/x <a@b.example>" });
  assert.match(hostile, /-m a@b\.example$/);
  assert.doesNotMatch(hostile, /\$\(/);
});

// ---------------------------------------------------------------------------
// B2: preserve certbot-managed TLS vhosts, timestamped backup before overwrite
// ---------------------------------------------------------------------------

const CERTBOT_VHOST = [
  "server {",
  "    listen 443 ssl; # managed by Certbot",
  "    ssl_certificate /etc/letsencrypt/live/status.nova.example/fullchain.pem; # managed by Certbot",
  "    ssl_certificate_key /etc/letsencrypt/live/status.nova.example/privkey.pem;",
  "    location / { proxy_pass http://127.0.0.1:3000; }",
  "}",
  "",
].join("\n");

const OLD_VHOST = ["server {", "    listen 80;", "    server_name old.example;", "}", ""].join("\n");

test("B2: isCertbotManagedVhost detects real TLS blocks, ignores commented placeholders", () => {
  assert.equal(isCertbotManagedVhost(renderVhost({ domain: "a.example.org", port: 3000 })), false);
  assert.equal(isCertbotManagedVhost("server {\n    listen 443 ssl; # managed by Certbot\n}"), true);
  assert.equal(
    isCertbotManagedVhost("server {\n    listen [::]:443 ssl http2;\n}"),
    true,
  );
  assert.equal(
    isCertbotManagedVhost("server {\n    ssl_certificate /etc/letsencrypt/live/a.example.org/fullchain.pem;\n}"),
    true,
  );
  assert.equal(isCertbotManagedVhost("server {\n    # listen 443 ssl;\n    # ssl_certificate /x;\n}"), false);
  assert.equal(isCertbotManagedVhost("server {\n    listen 80;\n}"), false);
});

test("B2: timestampedBackupPath is deterministic and filesystem safe", () => {
  const backup = timestampedBackupPath(
    "/etc/nginx/sites-available/status.nova.example.conf",
    new Date("2026-10-29T05:20:00.000Z"),
  );
  assert.equal(backup, "/etc/nginx/sites-available/status.nova.example.conf.bak.2026-10-29T05-20-00-000Z");
  assert.doesNotMatch(backup, /:/);
});

test("B2: apply preserves a certbot-managed TLS vhost; --force rewrites it with a backup", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  const enabledDir = path.join(root, "enabled");
  const configPath = path.join(nginxDir, "status.nova.example.conf");
  const env = { RELABEL_NGINX_DIR: nginxDir, RELABEL_NGINX_ENABLED_DIR: enabledDir };
  await mkdir(nginxDir, { recursive: true });
  await writeFile(configPath, CERTBOT_VHOST, "utf8");
  try {
    const plain = makeCtx(root, true);
    const plainCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--json"], plain.ctx));
    assert.equal(plainCode, 0);
    const plainJson = JSON.parse(plain.out[0]) as Record<string, any>;
    assert.equal(plainJson.nginx.preserved, true);
    // The vhost file is untouched even though the symlink step may still run.
    const vhostStep = plainJson.steps.find((s: any) => s.id === "nginx:vhost");
    assert.equal(vhostStep.status, "skipped");
    assert.match(vhostStep.detail, /preserved .*--force/);
    assert.equal(await readFile(configPath, "utf8"), CERTBOT_VHOST);
    assert.deepEqual((await readdir(nginxDir)).filter((f) => f.includes(".bak.")), []);

    const forced = makeCtx(root, true);
    const forcedCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--force", "--json"], forced.ctx));
    assert.equal(forcedCode, 0);
    const forcedJson = JSON.parse(forced.out[0]) as Record<string, any>;
    assert.equal(forcedJson.nginx.changed, true);
    assert.equal(forcedJson.nginx.preserved, undefined);
    assert.ok(forcedJson.nginx.backup, "forced rewrite must record a backup path");
    const backedUp = await readFile(forcedJson.nginx.backup, "utf8");
    assert.equal(backedUp, CERTBOT_VHOST);
    assert.match(backedUp, /ssl_certificate/);
    const rewritten = await readFile(configPath, "utf8");
    assert.match(rewritten, /relabeld — nginx vhost/);
    assert.equal(isCertbotManagedVhost(rewritten), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("B2: apply backs up an existing non-TLS vhost before overwriting, once", async () => {
  const { root, app, brand } = await tempRoot();
  const nginxDir = path.join(root, "nginx");
  const enabledDir = path.join(root, "enabled");
  const configPath = path.join(nginxDir, "status.nova.example.conf");
  const env = { RELABEL_NGINX_DIR: nginxDir, RELABEL_NGINX_ENABLED_DIR: enabledDir };
  await mkdir(nginxDir, { recursive: true });
  await writeFile(configPath, OLD_VHOST, "utf8");
  try {
    const first = makeCtx(root, true);
    const firstCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--json"], first.ctx));
    assert.equal(firstCode, 0);
    const firstJson = JSON.parse(first.out[0]) as Record<string, any>;
    assert.equal(firstJson.nginx.changed, true);
    assert.ok(firstJson.nginx.backup, "overwrite must record a backup path");
    assert.equal(await readFile(firstJson.nginx.backup, "utf8"), OLD_VHOST);
    assert.match(await readFile(configPath, "utf8"), /relabeld — nginx vhost/);
    const backups = (await readdir(nginxDir)).filter((f) => f.includes(".bak."));
    assert.equal(backups.length, 1);

    const second = makeCtx(root, true);
    const secondCode = await withEnv(env, () => run([app, "--brand", brand, "--apply", "--json"], second.ctx));
    assert.equal(secondCode, 0);
    const secondJson = JSON.parse(second.out[0]) as Record<string, any>;
    assert.equal(secondJson.nginx.changed, false);
    assert.equal(secondJson.nginx.backup, undefined);
    assert.equal((await readdir(nginxDir)).filter((f) => f.includes(".bak.")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M4/M5: composite action pin + fail-on matcher (screenshot/screenshots)
// ---------------------------------------------------------------------------

function actionDoc(): any {
  return YAML.parse(readFileSync(new URL("../action.yml", import.meta.url), "utf8"));
}

test("action.yml: version pinned to 1.0.0 and fail-on documents screenshot(s)", () => {
  const doc = actionDoc();
  assert.equal(doc.inputs.version.default, "1.0.0");
  assert.doesNotMatch(doc.inputs.version.default, /latest/);
  assert.match(doc.inputs["fail-on"].description, /screenshot/i);
});

test("action fail-on matcher: screenshot and screenshots both gate; other groups do not", async () => {
  const doc = actionDoc();
  const step = doc.runs.steps.find((s: any) => s.name === "Apply fail-on policy");
  assert.ok(step, "fail-on policy step present");
  const match = String(step.run).match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE\b/);
  assert.ok(match, "node matcher heredoc found in action.yml");

  const scriptPath = path.join(tmpdir(), `relabel-matcher-${process.pid}.cjs`);
  const jsonPath = path.join(tmpdir(), `relabel-checks-${process.pid}.json`);
  writeFileSync(scriptPath, match[1], "utf8");
  const runMatcher = (checks: unknown[], failOn: string) => {
    writeFileSync(jsonPath, JSON.stringify({ checks, summary: {} }), "utf8");
    const res = spawnSync(process.execPath, [scriptPath, jsonPath, failOn, "1"], { encoding: "utf8" });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  };
  try {
    const failedShots = [{ id: "screenshots", status: "fail" }];
    assert.equal(runMatcher(failedShots, "screenshot").status, 1, "singular screenshot gates plural screenshots");
    assert.equal(runMatcher(failedShots, "screenshots").status, 1, "plural screenshots gates itself");
    assert.equal(runMatcher(failedShots, "brand,console,overflow").status, 0, "unrelated groups do not gate");
    assert.equal(runMatcher([{ id: "brand-title", status: "fail" }], "brand").status, 1);
    assert.equal(runMatcher([{ id: "console-errors", status: "fail" }], "console").status, 1);
    assert.equal(runMatcher([{ id: "overflow-desktop", status: "fail" }], "overflow").status, 1);
    const pass = runMatcher([{ id: "brand-title", status: "pass" }], "brand");
    assert.equal(pass.status, 0);
    assert.match(pass.out, /gate: pass/);
  } finally {
    await rm(scriptPath, { force: true });
    await rm(jsonPath, { force: true });
  }
});
