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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * System browser candidates, in order. Env override aliases (first non-empty wins):
 * RELABEL_CHROME, then RELABEL_CHROMIUM_PATH (the Docker image sets the latter to
 * Debian's /usr/bin/chromium).
 */
export function browserCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const envPath = firstNonEmpty(env.RELABEL_CHROME, env.RELABEL_CHROMIUM_PATH);
  return [
    envPath,
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((value): value is string => Boolean(value));
}

/** Candidates resolved once at module load (launchBrowser re-resolves to honour late env). */
export const BROWSER_CANDIDATES = browserCandidates();

const PROBE_EXPR = `(() => {
  const body = document.body;
  const html = document.documentElement;
  const link = document.querySelector('link[rel~="icon"]');
  return {
    title: document.title || "",
    text: body ? body.innerText || "" : "",
    html: html ? html.outerHTML || "" : "",
    scrollWidth: html ? html.scrollWidth : 0,
    innerWidth: window.innerWidth,
    faviconUrl: link && link.href ? link.href : "",
  };
})()`;

interface Probe {
  viewport: string;
  title: string;
  text: string;
  html: string;
  scrollWidth: number;
  innerWidth: number;
  /** Runtime DOM href of the icon link ("" when absent). */
  faviconUrl?: string;
  navError?: string;
}

interface FaviconProbe {
  url: string;
  /** Where the candidate came from: served HTML, rewritten DOM, or /favicon.ico fallback. */
  source: "html" | "dom" | "fallback";
  /** "http" = fetched over the network; "data" = decoded inline data URI; "skip" = not verifiable. */
  kind: "http" | "data" | "skip";
  status: number;
  hash: string | null;
  error?: string;
  skipReason?: string;
}

/** A configured brand image that a served favicon may legitimately match. */
interface ExpectedBrandAsset {
  kind: "favicon" | "logo";
  configured: string;
  path: string;
  hash?: string;
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
  "  --executable <path> specific Chromium/Chrome binary to launch",
  "  --out <file>        also write the VerifyResult JSON here",
  "  --json              machine-readable output",
  "  -h, --help          show this help",
].join("\n");

/** Launch a headless Chromium from the system browser candidates, or attach over CDP. */
export async function launchBrowser(opts: { cdp?: string; executablePath?: string } = {}): Promise<Browser> {
  if (opts.cdp) {
    return chromium.connectOverCDP(opts.cdp);
  }
  const candidates = [opts.executablePath, ...browserCandidates()].filter(
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

/** A browser we launched ourselves may be closed; a CDP-attached browser is shared. */
export function shouldCloseBrowser(cdp?: string): boolean {
  return !cdp;
}

/**
 * Horizontal overflow: `scrollWidth - innerWidth <= 0` passes. A negative difference
 * is normal (classic scrollbars make `innerWidth` wider than the document's
 * `scrollWidth`) and must not fail the gate. Only positive overflow fails.
 */
export function evaluateOverflow(
  scrollWidth: number,
  innerWidth: number,
): { pass: boolean; diff: number; detail: string } {
  const diff = scrollWidth - innerWidth;
  return {
    pass: diff <= 0,
    diff,
    detail: `scrollWidth ${scrollWidth} − innerWidth ${innerWidth} = ${diff}`,
  };
}

/**
 * Ignore the browser's own console noise for an implicit `/favicon.ico` 404: Chromium
 * logs "Failed to load resource" when it auto-requests the missing default icon. Real
 * console errors (other URLs, other messages) still fail the check.
 */
export function isImplicitFaviconNoise(text: string, url: string): boolean {
  if (!/failed to load resource/i.test(text)) return false;
  if (!url) return false;
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    return pathname.toLowerCase().endsWith("/favicon.ico");
  } catch {
    const withoutQuery = url.replace(/[?#].*$/, "");
    return /(?:^|\/)favicon\.ico$/i.test(withoutQuery);
  }
}

/** Read one attribute value from a raw HTML tag string (quoted or unquoted). */
export function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = re.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Find the first `<link rel="icon">` href in the RAW served HTML (i.e. before any JS
 * rewrites it) and resolve it against the page URL. `apple-touch-icon` is not an icon link.
 */
export function parseIconLinkHref(html: string, baseUrl: string): string | null {
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRe)) {
    const tag = match[0];
    const rel = attrValue(tag, "rel");
    if (!rel) continue;
    if (!rel.toLowerCase().trim().split(/\s+/).includes("icon")) continue;
    const href = attrValue(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** Percent-decode a data-URI payload into bytes (exact bytes, not a UTF-8 round-trip). */
export function percentDecodeToBuffer(payload: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; ) {
    const ch = payload[i];
    if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(payload.slice(i + 1, i + 3))) {
      bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const cp = payload.codePointAt(i)!;
    const chStr = String.fromCodePoint(cp);
    for (const b of Buffer.from(chStr, "utf8")) bytes.push(b);
    i += chStr.length;
  }
  return Buffer.from(bytes);
}

/** Decode a `data:` URI (base64 or percent-encoded) into the exact bytes it represents. */
export function decodeDataUri(uri: string): Buffer {
  const comma = uri.indexOf(",");
  if (!uri.toLowerCase().startsWith("data:") || comma === -1) {
    throw new Error("not a data: URI");
  }
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1).replace(/\s+/g, "");
  if (/;\s*base64\s*$/i.test(meta)) return Buffer.from(payload, "base64");
  return percentDecodeToBuffer(payload);
}

export interface FaviconCandidate {
  url: string;
  source: "html" | "dom" | "fallback";
}

/**
 * Pick the favicon to verify. The served HTML is authoritative (that is what the
 * deployment ships); the runtime DOM is a fallback because JS may rewrite the link
 * (e.g. Uptime Kuma's canvas-generated data: URI badge).
 */
export function resolveFaviconCandidate(
  rawHtml: string | null,
  domHref: string,
  pageUrl: string,
): FaviconCandidate | null {
  if (rawHtml) {
    const fromHtml = parseIconLinkHref(rawHtml, pageUrl);
    if (fromHtml) return { url: fromHtml, source: "html" };
  }
  if (domHref) {
    try {
      return { url: new URL(domHref, pageUrl).href, source: "dom" };
    } catch {
      /* fall through to the /favicon.ico fallback */
    }
  }
  try {
    return { url: new URL("/favicon.ico", pageUrl).href, source: "fallback" };
  } catch {
    return null;
  }
}

async function fetchRawHtml(
  context: import("playwright-core").BrowserContext,
  pageUrl: string,
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const resp = await context.request.get(pageUrl, { timeout: 20_000 });
    if (!resp.ok()) return null;
    const html = await resp.text();
    return { html, finalUrl: resp.url() || pageUrl };
  } catch {
    return null;
  }
}

/** Configured brand images (favicon and/or logo) with their sha256 hashes. */
async function loadBrandAssets(brand: BrandSpec, brandDir: string): Promise<ExpectedBrandAsset[]> {
  const configured: Array<["favicon" | "logo", string | undefined]> = [
    ["favicon", brand.favicon],
    ["logo", brand.logo],
  ];
  const assets: ExpectedBrandAsset[] = [];
  for (const [kind, rel] of configured) {
    if (!rel) continue;
    const assetPath = path.resolve(brandDir, rel);
    try {
      assets.push({ kind, configured: rel, path: assetPath, hash: sha256(await readFile(assetPath)) });
    } catch (err) {
      assets.push({
        kind,
        configured: rel,
        path: assetPath,
        error: err instanceof Error ? err.message.split("\n")[0] : String(err),
      });
    }
  }
  return assets;
}

function describeAssets(assets: ExpectedBrandAsset[]): string {
  return assets
    .map((a) => `brand ${a.kind} ${a.configured} (${a.hash ? a.hash.slice(0, 12) + "…" : "unreadable"})`)
    .join(", ");
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
  let ignoredFavicon404 = 0;
  let faviconProbe: FaviconProbe | null = null;
  let launchError: string | null = null;
  const brandAssets = await loadBrandAssets(brand, brandDir);

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
          if (msg.type() !== "error") return;
          const text = clip(msg.text(), 500);
          let locationUrl = "";
          try {
            locationUrl = msg.location()?.url ?? "";
          } catch {
            locationUrl = "";
          }
          if (isImplicitFaviconNoise(text, locationUrl)) {
            ignoredFavicon404 += 1;
            return;
          }
          consoleErrors.push(text);
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

          if (vp.name === "desktop" && brandAssets.length > 0) {
            // The served HTML is authoritative: JS may rewrite the icon href after load
            // (e.g. a canvas-rendered data: URI). Only fall back to the runtime DOM when
            // the raw HTML declares no icon link at all.
            const raw = await fetchRawHtml(context, url);
            const candidate = resolveFaviconCandidate(
              raw?.html ?? null,
              probe.faviconUrl ?? "",
              raw?.finalUrl ?? url,
            );
            if (candidate) faviconProbe = await probeFavicon(context, candidate);
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
    // Never close a CDP-attached browser: it is a shared, externally-owned session.
    if (browser && shouldCloseBrowser(opts.cdp)) await browser.close().catch(() => undefined);
  }

  // ---- brand-strings: zero old-brand variants in rendered text + HTML ----
  const variants = (brand.variants ?? []).filter((v) => typeof v === "string" && v.trim().length > 0);
  if (variants.length === 0) {
    checks.push({
      id: "brand-strings",
      title: "old brand strings absent",
      status: "fail",
      detail: "no old-brand variants configured; run scan/init",
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
  const ignoredSuffix =
    ignoredFavicon404 > 0
      ? ` (ignored ${ignoredFavicon404} implicit /favicon.ico 404${ignoredFavicon404 === 1 ? "" : "s"})`
      : "";
  checks.push({
    id: "console-errors",
    title: "no console/page errors",
    status: errorCount === 0 ? "pass" : "fail",
    detail:
      (errorCount === 0
        ? "0 page errors, 0 console errors"
        : `${errorCount} error${errorCount === 1 ? "" : "s"} (${pageErrors.length} page, ${consoleErrors.length} console): ${[...pageErrors, ...consoleErrors]
            .slice(0, 3)
            .join(" | ")}`) + ignoredSuffix,
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
    const overflow = evaluateOverflow(probe.scrollWidth, probe.innerWidth);
    checks.push({
      id,
      title: `no horizontal overflow (${vp.width}×${vp.height})`,
      status: overflow.pass ? "pass" : "fail",
      detail: overflow.detail,
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

  // ---- favicon: served brand asset matches the configured favicon/logo ----
  if (brandAssets.length === 0) {
    checks.push({
      id: "favicon",
      title: "favicon matches brand asset",
      status: "skip",
      detail: "brand.favicon / brand.logo not configured",
    });
  } else {
    const readable = brandAssets.filter((asset) => Boolean(asset.hash));
    const unreadable = brandAssets.filter((asset) => !asset.hash);
    const probe = faviconProbe as FaviconProbe | null;
    let status: CheckResult["status"] = "fail";
    let detail: string;
    if (readable.length === 0) {
      detail = `cannot read configured brand asset(s): ${brandAssets
        .map((asset) => `${asset.configured} (${asset.error ?? "unreadable"})`)
        .join(", ")}`;
    } else if (!probe) {
      detail = "favicon not probed (page did not render)";
    } else if (probe.kind === "skip") {
      status = "skip";
      detail = probe.skipReason ?? "favicon scheme is not verifiable";
    } else if (probe.error) {
      if (probe.kind === "data") {
        status = "skip";
        detail = `runtime-generated favicon (data: URI) could not be decoded: ${probe.error}`;
      } else {
        detail = `favicon fetch failed: ${probe.error}`;
      }
    } else if (probe.kind === "data") {
      const matched = readable.find((asset) => asset.hash === probe.hash);
      if (matched) {
        status = "pass";
        detail = `data: URI favicon, sha256 ${matched.hash!.slice(0, 12)}… matches brand ${matched.kind} ${matched.configured}`;
      } else {
        status = "skip";
        detail = `runtime-generated favicon (data: URI): sha256 ${probe.hash ? probe.hash.slice(0, 12) + "…" : "unknown"} differs from ${describeAssets(readable)}`;
      }
    } else if (probe.status !== 200) {
      detail = `favicon HTTP ${probe.status} for ${schemeless(probe.url)} (expected 200)`;
    } else if (!probe.hash) {
      detail = `favicon body could not be hashed (${schemeless(probe.url)})`;
    } else {
      const matched = readable.find((asset) => asset.hash === probe.hash);
      if (matched) {
        status = "pass";
        detail = `HTTP 200, sha256 ${matched.hash!.slice(0, 12)}… matches brand ${matched.kind} ${matched.configured} (${schemeless(probe.url)})`;
      } else {
        detail = `sha256 mismatch: served ${probe.hash.slice(0, 12)}… ≠ ${describeAssets(readable)} (${schemeless(probe.url)})`;
      }
    }
    if (unreadable.length > 0 && status !== "pass") {
      detail += `; unreadable configured brand asset(s): ${unreadable.map((asset) => asset.configured).join(", ")}`;
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

async function probeFavicon(
  context: import("playwright-core").BrowserContext,
  candidate: FaviconCandidate,
): Promise<FaviconProbe> {
  const base = { url: candidate.url, source: candidate.source, status: 0, hash: null };
  if (!candidate.url) {
    return { ...base, kind: "skip", skipReason: "no favicon URL in served HTML or DOM" };
  }
  let scheme = "";
  try {
    scheme = new URL(candidate.url).protocol.toLowerCase();
  } catch {
    scheme = "";
  }
  if (scheme === "data:") {
    try {
      return { ...base, kind: "data", status: 200, hash: sha256(decodeDataUri(candidate.url)) };
    } catch (err) {
      return {
        ...base,
        kind: "data",
        error: err instanceof Error ? err.message.split("\n")[0] : String(err),
      };
    }
  }
  if (scheme && scheme !== "http:" && scheme !== "https:") {
    return {
      ...base,
      kind: "skip",
      skipReason: `favicon scheme "${scheme}" is not verifiable (${candidate.source === "dom" ? "runtime-generated" : "declared"})`,
    };
  }
  try {
    const resp = await context.request.get(candidate.url, { timeout: 15_000 });
    const body = await resp.body();
    return {
      ...base,
      kind: "http",
      status: resp.status(),
      hash: resp.status() === 200 ? sha256(body) : null,
    };
  } catch (err) {
    return {
      ...base,
      kind: "http",
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
