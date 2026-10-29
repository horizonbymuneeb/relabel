import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ctx } from "./types.js";

const execCommand = promisify(execFile);

interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

async function cmdVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execCommand(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

async function executable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function collectChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: nodeMajor >= 20,
    required: true,
    detail: `v${process.versions.node}${nodeMajor >= 20 ? "" : " (need >= 20)"}`,
  });

  const docker = await cmdVersion("docker", ["--version"]);
  checks.push({ name: "docker", ok: Boolean(docker), required: false, detail: docker ?? "not found (needed to run apps)" });

  let browser = "";
  const envBrowser = process.env.RELABEL_CHROME ?? process.env.RELABEL_CHROMIUM_PATH ?? "";
  const candidates = [
    ...(envBrowser ? [envBrowser] : []),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (!(await executable(candidate))) continue;
    // Snap shims and broken wrappers can exist without working; probe by executing.
    const version = await cmdVersion(candidate, ["--version"]);
    if (version && /chrom(e|ium)/i.test(version)) {
      browser = `${candidate} (${version})`;
      break;
    }
  }
  checks.push({
    name: "browser",
    ok: Boolean(browser),
    required: true,
    detail: browser || "no chromium/chrome found (pass --cdp or install one)",
  });

  const nginx = await cmdVersion("nginx", ["-v"]);
  checks.push({ name: "nginx", ok: Boolean(nginx), required: false, detail: nginx ? "installed" : "not found (only for deploy)" });

  const certbot = await cmdVersion("certbot", ["--version"]);
  checks.push({ name: "certbot", ok: Boolean(certbot), required: false, detail: certbot ?? "not found (only for deploy)" });

  const cfToken = Boolean(process.env.CF_DNS_ADMIN_TOKEN);
  checks.push({
    name: "cloudflare-token",
    ok: cfToken,
    required: false,
    detail: cfToken ? "CF_DNS_ADMIN_TOKEN set" : "CF_DNS_ADMIN_TOKEN not set (only for deploy --apply)",
  });

  return checks;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.log("Usage: relabeld doctor [--json]\n\nCheck the local environment for scan/verify/deploy readiness.");
    return 0;
  }
  const checks = await collectChecks();
  const failedRequired = checks.filter((c) => c.required && !c.ok);

  if (ctx.json) {
    console.log(JSON.stringify({ checks, ok: failedRequired.length === 0 }, null, 2));
  } else {
    const width = Math.max(...checks.map((c) => c.name.length));
    ctx.log("relabeld doctor\n");
    for (const c of checks) {
      const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn";
      ctx.log(`  ${c.name.padEnd(width)}  ${mark}  ${c.detail}`);
    }
    ctx.log(`\n${failedRequired.length === 0 ? "environment ready" : `${failedRequired.length} required check(s) failed`}`);
  }
  return failedRequired.length === 0 ? 0 : 1;
}
