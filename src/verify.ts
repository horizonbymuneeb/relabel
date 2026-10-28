import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { BrandSpec, CheckResult, Ctx, VerifyResult } from "./types.js";
import { countOccurrences, ensureDir, loadYamlFile, nowIso, sha256 } from "./util.js";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 980 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/** System browser candidates, in order. Override with RELABEL_CHROME. */
export const BROWSER_CANDIDATES = [
  process.env.RELABEL_CHROME,
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter((v): v is string => Boolean(v));

const PROBE_EXPR = `(() => {
  const body = document.body;
  const html = document.documentElement;
  const link = document.querySelector('link[rel~="icon"]');
  let faviconUrl = "";
  try {
    faviconUrl = link && link.href ? link.href : new URL("/favicon.ico", location.href).href;
  } catch {
    faviconUrl = "";
  }
  return {
    title: document.title || "",
    text: body ? body.innerText || "" : "",
    html: html ? html.outerHTML || "" : "",
    scrollWidth: html ? html.scrollWidth : 0,
    innerWidth: window.innerWidth,
    faviconUrl,
  };
})()`;

interface Probe {
  viewport: string;
  title: string;
  text: string;
  html: string;
  scrollWidth: number;
  innerWidth: number;
  faviconUrl?: string;
  navError?: string;
}

interface FaviconProbe {
  url: string;
  status: number;
  hash: string | null;
  error?: string;
}

export interface VerifyOptions {
  url: string;
  brand: BrandSpec;
  /** Directory used to resolve relative asset paths from brand.yaml. */
  brandDir?: string;
  shotsDir: string;
  cdp?: string;
  /** Optional explicit browser executable (tests / exotic hosts). */
  executablePath?: string;
  log?: (msg: string) => void;
}

export interface VerifyOutcome {
  result: VerifyResult;
  exitCode: number;
}

const USAGE = [
  "Usage: relabeld verify --url <URL> --brand <brand.yaml> [options]",
  "",
  "Options:",
  "  --url <URL>         page to verify (required)",
  "  --brand <file>      brand spec YAML (default: brand.yaml)",
  "  --shots <dir>       screenshot output dir (default: .relabel/verify)",
  "  --cdp <ws-url>      attach to an existing Chromium over CDP",
  "  --out <file>        also write the VerifyResult JSON here",
  "  --json              machine-readable output",
  "  -h, --help          show this help",
].join("\n");

/** Launch a headless Chromium from the system browser candidates, or attach over CDP. */
export async function launchBrowser(opts: { cdp?: string; executablePath?: string } = {}): Promise<Browser> {
  if (opts.cdp) {
    return chromium.connectOverCDP(opts.cdp);
  }
  const candidates = [opts.executablePath, ...BROWSER_CANDIDATES].filter(
    (v): v is string => Boolean(v),
  );
  const tried: string[] = [];
  let lastError: unknown = null;
  for (const exe of [...new Set(candidates)]) {
    if (!existsSync(exe)) continue;
    tried.push(exe);
    try {
      return await chromium.launch({ executablePath: exe, headless: true });
    } catch (err) {
      lastError = err;
    }
  }
  const reason = lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError ?? "no browser binary found");
  throw new Error(
    `could not launch headless Chromium (tried: ${tried.join(", ") || "none"}): ${reason}`,
  );
}

async function navigate(page: import("playwright-core").Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(100);
}

function clip(s: string, max = 600_000): string {
  return s.length > max ? s.slice(0, max) : s;
}

function schemeless(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

/** Run all checks against a live page. Returns the VerifyResult (no printing). */
export async function verifyPage(opts: VerifyOptions): Promise<VerifyResult> {
  const { url, brand, shotsDir } = opts;
  const brandDir = opts.brandDir ?? process.cwd();
  const checks: CheckResult[] = [];
  const screenshots: Array<{ name: string; path: string }> = [];
  const probes: Probe[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let faviconProbe: FaviconProbe | null = null;
  let launchError: string | null = null;

  await ensureDir(shotsDir);

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ cdp: opts.cdp, executablePath: opts.executablePath });
    const isCdp = Boolean(opts.cdp);
    const sharedContext = isCdp ? browser.contexts()[0] ?? (await browser.newContext()) : null;

    for (const vp of VIEWPORTS) {
      const probe: Probe = {
        viewport: vp.name,
        title: "",
        text: "",
        html: "",
        scrollWidth: 0,
        innerWidth: 0,
      };
      let context: import("playwright-core").BrowserContext | null = null;
      try {
        context = isCdp
          ? sharedContext!
          : await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await context.newPage();
        if (isCdp) {
          try {
            await page.setViewportSize({ width: vp.width, height: vp.height });
          } catch {
            /* default CDP context may already pin a viewport */
          }
        }
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(clip(msg.text(), 500));
        });
        page.on("pageerror", (err) => pageErrors.push(clip(err?.message ?? String(err), 500)));

        try {
          await navigate(page, url);
          const data = (await page.evaluate(PROBE_EXPR)) as Omit<Probe, "viewport" | "navError">;
          probe.title = clip(String(data.title ?? ""), 2_000);
          probe.text = clip(String(data.text ?? ""));
          probe.html = clip(String(data.html ?? ""), 2_000_000);
          probe.scrollWidth = Number(data.scrollWidth ?? 0);
          probe.innerWidth = Number(data.innerWidth ?? 0);
          probe.faviconUrl = typeof data.faviconUrl === "string" ? data.faviconUrl : "";

          if (vp.name === "mobile" && brand.favicon) {
            faviconProbe = await fetchFavicon(context, probe.faviconUrl ?? "");
          }
        } catch (err) {
          probe.navError = err instanceof Error ? err.message.split("\n")[0] : String(err);
        }

        const shotPath = path.resolve(shotsDir, `${vp.name}.png`);
        try {
          await page.screenshot({ path: shotPath, fullPage: false });
        } catch (err) {
          if (!probe.navError) {
            probe.navError = `screenshot failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
          }
        }
        screenshots.push({ name: vp.name, path: shotPath });
        try {
          await page.close();
        } catch {
          /* ignore */
        }
      } finally {
        if (context && !isCdp) await context.close().catch(() => undefined);
      }
      probes.push(probe);
    }
  } catch (err) {
    launchError = err instanceof Error ? err.message : String(err);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  // ---- brand-strings: zero old-brand variants in rendered text + HTML ----
  const variants = (brand.variants ?? []).filter((v) => typeof v === "string" && v.trim().length > 0);
  if (variants.length === 0) {
    checks.push({
      id: "brand-strings",
      title: "old brand strings absent",
      status: "pass",
      detail: "no old-brand variants configured",
    });
  } else if (probes.length === 0) {
    checks.push({
      id: "brand-strings",
      title: "old brand strings absent",
      status: "fail",
      detail: "page did not render — cannot prove old-brand strings are gone",
    });
  } else {
    const hits: string[] = [];
    let total = 0;
    for (const variant of variants) {
      const inText = probes.reduce((n, p) => n + countOccurrences(p.text, variant), 0);
      const inHtml = probes.reduce((n, p) => n + countOccurrences(p.html, variant), 0);
      const n = inText + inHtml;
      if (n > 0) {
        total += n;
        hits.push(`"${variant}" ×${n}`);
      }
    }
    checks.push({
      id: "brand-strings",
      title: "old brand strings absent",
      status: total === 0 ? "pass" : "fail",
      detail:
        total === 0
          ? `0 occurrences across ${variants.length} old-brand variant${variants.length === 1 ? "" : "s"} (rendered text + HTML)`
          : `${total} occurrence${total === 1 ? "" : "s"}: ${hits.join(", ")}`,
    });
  }

  // ---- brand-title: new brand name in <title> ----
  const brandName = (brand.name ?? "").trim();
  const titles = probes.map((p) => ({ viewport: p.viewport, title: p.title }));
  const titleOk =
    titles.length > 0 && titles.every((t) => t.title.toLowerCase().includes(brandName.toLowerCase()));
  checks.push({
    id: "brand-title",
    title: "new brand in <title>",
    status: titleOk ? "pass" : "fail",
    detail: titleOk
      ? titles.map((t) => `${t.viewport}: "${t.title}"`).join("; ")
      : `title does not contain "${brandName}": ${titles.map((t) => `${t.viewport}: "${t.title}"`).join("; ") || "no page rendered"}`,
  });

  // ---- console-errors: zero page errors / console errors ----
  const errorCount = pageErrors.length + consoleErrors.length;
  checks.push({
    id: "console-errors",
    title: "no console/page errors",
    status: errorCount === 0 ? "pass" : "fail",
    detail:
      errorCount === 0
        ? "0 page errors, 0 console errors"
        : `${errorCount} error${errorCount === 1 ? "" : "s"} (${pageErrors.length} page, ${consoleErrors.length} console): ${[...pageErrors, ...consoleErrors]
            .slice(0, 3)
            .join(" | ")}`,
  });

  // ---- overflow: scrollWidth - innerWidth === 0 per viewport ----
  for (const vp of VIEWPORTS) {
    const probe = probes.find((p) => p.viewport === vp.name);
    const id = `overflow-${vp.name}`;
    if (!probe) {
      checks.push({
        id,
        title: `no horizontal overflow (${vp.width}×${vp.height})`,
        status: "fail",
        detail: launchError ? `browser failed: ${launchError}` : "viewport not probed",
      });
      continue;
    }
    if (probe.navError) {
      checks.push({
        id,
        title: `no horizontal overflow (${vp.width}×${vp.height})`,
        status: "fail",
        detail: `navigation failed: ${probe.navError}`,
      });
      continue;
    }
    const diff = probe.scrollWidth - probe.innerWidth;
    checks.push({
      id,
      title: `no horizontal overflow (${vp.width}×${vp.height})`,
      status: diff === 0 ? "pass" : "fail",
      detail: `scrollWidth ${probe.scrollWidth} − innerWidth ${probe.innerWidth} = ${diff}`,
    });
  }

  // ---- screenshots: both viewports saved ----
  const missing: string[] = [];
  const saved: string[] = [];
  for (const vp of VIEWPORTS) {
    const shot = screenshots.find((s) => s.name === vp.name);
    if (!shot) {
      missing.push(`${vp.name}: not captured`);
      continue;
    }
    try {
      const bytes = (await readFile(shot.path)).length;
      if (bytes === 0) missing.push(`${vp.name}: empty file`);
      else saved.push(`${vp.name} (${bytes} bytes)`);
    } catch {
      missing.push(`${vp.name}: missing ${shot.path}`);
    }
  }
  checks.push({
    id: "screenshots",
    title: "desktop + mobile screenshots",
    status: missing.length === 0 && screenshots.length === VIEWPORTS.length ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `saved ${saved.join(", ")} in ${path.resolve(shotsDir)}`
        : missing.join("; "),
  });

  // ---- favicon: HTTP 200 + sha256 matches brand asset (skip when not configured) ----
  if (!brand.favicon) {
    checks.push({
      id: "favicon",
      title: "favicon matches brand asset",
      status: "skip",
      detail: "brand.favicon not configured",
    });
  } else {
    const brandFaviconPath = path.resolve(brandDir, brand.favicon);
    let expectedHash: string | null = null;
    let expectedError: string | null = null;
    try {
      expectedHash = sha256(await readFile(brandFaviconPath));
    } catch (err) {
      expectedError = `cannot read brand favicon ${brandFaviconPath}: ${
        err instanceof Error ? err.message.split("\n")[0] : String(err)
      }`;
    }
    let status: CheckResult["status"] = "fail";
    let detail: string;
    if (expectedError) {
      detail = expectedError;
    } else if (!faviconProbe) {
      detail = "favicon not probed (page did not render)";
    } else if (faviconProbe.error) {
      detail = `favicon fetch failed: ${faviconProbe.error}`;
    } else if (faviconProbe.status !== 200) {
      detail = `favicon HTTP ${faviconProbe.status} for ${schemeless(faviconProbe.url)}`;
    } else if (!faviconProbe.hash) {
      detail = `favicon body could not be hashed (${schemeless(faviconProbe.url)})`;
    } else if (faviconProbe.hash !== expectedHash) {
      detail = `sha256 mismatch: page ${faviconProbe.hash.slice(0, 12)}… ≠ brand ${expectedHash!.slice(0, 12)}…`;
    } else {
      status = "pass";
      detail = `HTTP 200, sha256 ${expectedHash!.slice(0, 12)}… matches ${schemeless(faviconProbe.url)}`;
    }
    checks.push({ id: "favicon", title: "favicon matches brand asset", status, detail });
  }

  const summary = {
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };

  return {
    url,
    brandName,
    checks,
    screenshots,
    summary,
    generatedAt: nowIso(),
  };
}

async function fetchFavicon(
  context: import("playwright-core").BrowserContext,
  faviconUrl: string,
): Promise<FaviconProbe> {
  if (!faviconUrl) {
    return { url: "", status: 0, hash: null, error: "no favicon URL in page" };
  }
  try {
    const resp = await context.request.get(faviconUrl, { timeout: 15_000 });
    const body = await resp.body();
    const hash = resp.status() === 200 ? sha256(body) : null;
    return { url: faviconUrl, status: resp.status(), hash };
  } catch (err) {
    return {
      url: faviconUrl,
      status: 0,
      hash: null,
      error: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

/** Format checks as a fixed-width human table. */
export function formatChecks(checks: CheckResult[]): string {
  const rows = checks.map((c) => ({
    status: c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP",
    id: c.id,
    detail: c.detail.replace(/\s+/g, " ").trim(),
  }));
  const wStatus = Math.max(6, ...rows.map((r) => r.status.length));
  const wId = Math.max(5, ...rows.map((r) => r.id.length));
  const lines = [
    `${"STATUS".padEnd(wStatus)}  ${"CHECK".padEnd(wId)}  DETAIL`,
    ...rows.map((r) => `${r.status.padEnd(wStatus)}  ${r.id.padEnd(wId)}  ${r.detail}`),
  ];
  return lines.join("\n");
}

/** Parse argv and run the verification. JSON mode prints exactly one JSON object. */
export async function run(argv: string[], ctx: Ctx): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        url: { type: "string" },
        brand: { type: "string" },
        shots: { type: "string" },
        cdp: { type: "string" },
        out: { type: "string" },
        executable: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    ctx.error(`verify: ${err instanceof Error ? err.message : String(err)}`);
    ctx.error(USAGE);
    return 2;
  }
  const values = parsed.values;
  if (values.help) {
    ctx.log(USAGE);
    return 0;
  }
  if (!values.url) {
    ctx.error("verify: --url is required");
    ctx.error(USAGE);
    return 2;
  }
  const brandPath = path.resolve(ctx.cwd, values.brand ?? "brand.yaml");
  let brand: BrandSpec;
  try {
    brand = await loadYamlFile<BrandSpec>(brandPath);
  } catch (err) {
    ctx.error(
      `verify: cannot read brand spec ${brandPath}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
    return 2;
  }
  if (!brand || typeof brand.name !== "string" || !brand.name.trim()) {
    ctx.error(`verify: brand spec ${brandPath} must define a non-empty "name"`);
    return 2;
  }
  if (!Array.isArray(brand.variants)) brand.variants = [];
  const shotsDir = path.resolve(ctx.cwd, values.shots ?? path.join(".relabel", "verify"));

  let result: VerifyResult;
  try {
    result = await verifyPage({
      url: values.url,
      brand,
      brandDir: path.dirname(brandPath),
      shotsDir,
      cdp: values.cdp,
      executablePath: values.executable,
    });
  } catch (err) {
    ctx.error(`verify: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (values.out) {
    const outPath = path.resolve(ctx.cwd, values.out);
    await ensureDir(path.dirname(outPath));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    if (!ctx.json) ctx.log(`wrote ${outPath}`);
  }

  if (ctx.json) {
    // Contract: exactly one JSON object on stdout.
    console.log(JSON.stringify(result, null, 2));
  } else {
    ctx.log(`relabeld verify ${ctx.version}`);
    ctx.log(`  url    ${schemeless(result.url)}`);
    ctx.log(`  brand  ${result.brandName}`);
    ctx.log(`  shots  ${path.resolve(shotsDir)}`);
    ctx.log("");
    ctx.log(formatChecks(result.checks));
    ctx.log("");
    ctx.log(
      `${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
    );
    const failures = result.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      ctx.error(`verification failed: ${failures.map((c) => c.id).join(", ")}`);
      return 1;
    }
  }
  return result.summary.failed > 0 ? 1 : 0;
}
