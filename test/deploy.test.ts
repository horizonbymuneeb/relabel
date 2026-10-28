import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  buildCloudflareDnsPayload,
  certbotEmail,
  nginxConfigPath,
  nginxEnabledPath,
  parseBrandSpec,
  parseDeployArgs,
  renderCertbotCommand,
  renderVhost,
  run,
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

  const unknown = parseDeployArgs(["--dry-run", "--force"]);
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
