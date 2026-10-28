export type FindingKind = "string" | "asset" | "config" | "docs" | "ci" | "license";

export interface Finding {
  file: string;
  line?: number;
  kind: FindingKind;
  token: string;
  match: string;
  confidence: "high" | "medium" | "low";
  suggestion?: string;
}

export interface AssetHit {
  file: string;
  kind: "logo" | "favicon" | "og-image" | "unknown";
  bytes: number;
  sha256: string;
}

export interface ScanResult {
  root: string;
  scannedFiles: number;
  brandTokens: string[];
  findings: Finding[];
  assets: AssetHit[];
  summaries: Record<string, number>;
  generatedAt: string;
}

export interface Palette {
  primary: string;
  accent?: string;
  background?: string;
}

export interface BrandSpec {
  name: string;
  domain?: string;
  palette: Palette;
  logo?: string;
  favicon?: string;
  emailFrom?: string;
  variants: string[];
  keep: string[];
}

export interface RecipeEnv {
  name: string;
  from?: string;
  value: string;
}

export interface RecipeAsset {
  kind: "logo" | "favicon" | "og-image";
  targets: string[];
}

/**
 * A repo path that must be renamed for rewritten module refs to resolve.
 * `to` may use brand placeholders: {{slug}}, {{snake}}, {{pascal}}, {{camel}},
 * {{name}}, {{lower}} (e.g. server/{{slug}}-server.js).
 */
export interface RecipeRename {
  from: string;
  to: string;
}

export interface RecipeFileRule {
  path: string;
  replace: Array<{ from: string; to: string }>;
}

export interface Recipe {
  id: string;
  name: string;
  upstream: string;
  docs?: string;
  match: string[];
  strings: string[];
  assets: RecipeAsset[];
  renames?: RecipeRename[];
  env?: RecipeEnv[];
  files?: RecipeFileRule[];
  compose?: { service?: string; port?: number; base?: string };
  verify?: { url?: string; paths?: string[] };
  notes?: string[];
}

export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface VerifyResult {
  url: string;
  brandName: string;
  checks: CheckResult[];
  screenshots: Array<{ name: string; path: string }>;
  summary: { passed: number; failed: number; skipped: number };
  generatedAt: string;
}

export interface Ctx {
  cwd: string;
  json: boolean;
  log: (msg: string) => void;
  error: (msg: string) => void;
  version: string;
}
