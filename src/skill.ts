import { parseArgs } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureDir } from "./util.js";
import YAML from "yaml";
import type { Ctx } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const DEFAULT_SOURCE = path.join(PACKAGE_ROOT, "skills", "relabel");

export const AGENTS = ["claude", "codex", "dsh"] as const;
export type Agent = (typeof AGENTS)[number];

const USAGE = [
  "Usage: relabeld skill install --agent claude|codex|dsh|all [options]",
  "       relabeld skill list",
  "",
  "Options:",
  "  --agent <name>   target agent: claude, codex, dsh, or all (required for install)",
  "  --prefix <dir>   install into <dir>/relabel instead of the agent's default skill root",
  "  --list           print the agent → skill-root map and exit",
  "  --no-verify      skip post-install verification",
  "  --json           machine-readable output",
  "  -h, --help       show this help",
  "",
  "Default skill roots:",
  "  claude  ~/.claude/skills",
  "  codex   ~/.codex/skills",
  "  dsh     ~/.dsh-home/skills",
].join("\n");

/** Default skill root per agent. */
export function agentRoots(home: string = homedir()): Record<Agent, string> {
  return {
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(home, ".codex", "skills"),
    dsh: path.join(home, ".dsh-home", "skills"),
  };
}

/** Effective roots after applying --prefix (used by --list and install). */
export function effectiveRoots(prefix?: string, home: string = homedir()): Record<Agent, string> {
  const roots = agentRoots(home);
  if (!prefix) return roots;
  const resolved = path.resolve(prefix);
  return { claude: resolved, codex: resolved, dsh: resolved };
}

export interface InstallFile {
  path: string;
  bytes: number;
}

export interface InstallRecord {
  agent: Agent;
  root: string;
  dir: string;
  files: InstallFile[];
}

export interface ParsedFrontmatter {
  /** YAML frontmatter object (empty when none parsed). */
  data: Record<string, unknown>;
  /** Markdown body after the closing `---`. */
  body: string;
  /** Raw frontmatter text (empty when none). */
  raw: string;
}

/** Parse leading YAML frontmatter from a SKILL.md. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text, raw: "" };
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(match[0].length), raw: match[1] };
}

async function listSourceFiles(dir: string, base: string = dir): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSourceFiles(abs, base)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push({ rel: path.relative(base, abs).split(path.sep).join("/"), abs });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Copy the bundled skill into <root>/relabel, returning what was written. */
export async function installSkill(
  agent: Agent,
  root: string,
  source: string = DEFAULT_SOURCE,
): Promise<InstallRecord> {
  const files = await listSourceFiles(source);
  if (files.length === 0) {
    throw new Error(`bundled skill not found at ${source} (expected SKILL.md)`);
  }
  const dir = path.join(path.resolve(root), "relabel");
  const installed: InstallFile[] = [];
  for (const file of files) {
    const target = path.join(dir, file.rel);
    const content = await readFile(file.abs);
    await ensureDir(path.dirname(target));
    await writeFile(target, content);
    installed.push({ path: file.rel, bytes: content.length });
  }
  return { agent, root: path.resolve(root), dir, files: installed };
}

/** Verify an installed skill: frontmatter, description, CLI documentation, references. */
export async function verifyInstall(record: InstallRecord): Promise<{ ok: boolean; problems: string[]; name?: string; references: number }> {
  const problems: string[] = [];
  const skillPath = path.join(record.dir, "SKILL.md");
  let text: string;
  try {
    text = await readFile(skillPath, "utf8");
  } catch {
    return { ok: false, problems: [`SKILL.md missing at ${skillPath}`], references: 0 };
  }
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name) problems.push("frontmatter: missing or empty `name`");
  if (!description) problems.push("frontmatter: missing or empty `description`");
  if (!name && Object.keys(data).length === 0) problems.push("frontmatter: not valid YAML");
  if (!body.includes("relabeld")) problems.push("body does not document the `relabeld` CLI");
  const refs = record.files.filter((f) => f.path.startsWith("references/") && f.path.endsWith(".md"));
  const refsOnDisk = existsSync(path.join(record.dir, "references"))
    ? (await readdir(path.join(record.dir, "references"))).filter((f) => f.endsWith(".md")).length
    : 0;
  if (refsOnDisk === 0) problems.push("references/: no reference markdown installed");
  return { ok: problems.length === 0, problems, name: name || undefined, references: refsOnDisk };
}

function humanLines(lines: string[], ctx: Ctx): void {
  for (const line of lines) ctx.log(line);
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        agent: { type: "string" },
        prefix: { type: "string" },
        list: { type: "boolean", default: false },
        "no-verify": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    ctx.error(`skill: ${err instanceof Error ? err.message : String(err)}`);
    ctx.error(USAGE);
    return 2;
  }
  const values = parsed.values;
  const positionals = parsed.positionals as string[];
  const sub = positionals[0];

  if (values.help) {
    ctx.log(USAGE);
    return 0;
  }

  const roots = effectiveRoots(values.prefix);
  const listRequested = values.list || sub === "list";

  if (listRequested) {
    const map = { ...roots } as Record<string, string>;
    if (ctx.json) {
      console.log(
        JSON.stringify(
          { roots: map, source: DEFAULT_SOURCE, agents: [...AGENTS], version: ctx.version },
          null,
          2,
        ),
      );
    } else {
      ctx.log(`relabeld skill roots (source: ${DEFAULT_SOURCE}):`);
      for (const agent of AGENTS) ctx.log(`  ${agent.padEnd(7)} ${map[agent]}`);
    }
    return 0;
  }

  if (!sub) {
    ctx.error("skill: missing subcommand");
    ctx.error(USAGE);
    return 2;
  }
  if (sub !== "install") {
    ctx.error(`skill: unknown subcommand "${sub}"`);
    ctx.error(USAGE);
    return 2;
  }

  const requested = values.agent;
  if (!requested) {
    ctx.error("skill: --agent is required (claude, codex, dsh, or all)");
    ctx.error(USAGE);
    return 2;
  }
  const targets: Agent[] =
    requested === "all"
      ? [...AGENTS]
      : AGENTS.includes(requested as Agent)
        ? [requested as Agent]
        : [];
  if (targets.length === 0) {
    ctx.error(`skill: unknown agent "${requested}" (expected claude, codex, dsh, or all)`);
    return 2;
  }
  if (!existsSync(path.join(DEFAULT_SOURCE, "SKILL.md"))) {
    ctx.error(`skill: bundled skill source missing at ${DEFAULT_SOURCE}`);
    return 1;
  }

  const records: InstallRecord[] = [];
  const verifyResults: Array<{ agent: Agent; ok: boolean; problems: string[]; name?: string; references: number }> = [];
  const seenDirs = new Set<string>();
  try {
    for (const agent of targets) {
      const root = roots[agent];
      const dir = path.join(path.resolve(root), "relabel");
      if (seenDirs.has(dir)) {
        // `--agent all --prefix DIR` installs once but still reports each agent.
        const existing = records.find((r) => r.dir === dir)!;
        records.push({ ...existing, agent, root: path.resolve(root) });
        verifyResults.push({ agent, ...(await verifyInstall(existing)) });
        continue;
      }
      seenDirs.add(dir);
      const record = await installSkill(agent, root, DEFAULT_SOURCE);
      records.push(record);
      if (!values["no-verify"]) {
        verifyResults.push({ ...{ agent }, ...(await verifyInstall(record)) });
      }
    }
  } catch (err) {
    ctx.error(`skill: install failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return 1;
  }

  const verified = !values["no-verify"] && verifyResults.every((v) => v.ok);
  const failedVerify = verifyResults.filter((v) => !v.ok);

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          installed: records.map((r) => ({
            agent: r.agent,
            root: r.root,
            dir: r.dir,
            files: r.files,
          })),
          verified: values["no-verify"] ? null : verified,
          verification: verifyResults.map((v) => ({
            agent: v.agent,
            ok: v.ok,
            name: v.name ?? null,
            references: v.references,
            problems: v.problems,
          })),
          version: ctx.version,
        },
        null,
        2,
      ),
    );
  } else {
    const lines: string[] = [`relabeld skill install ${ctx.version}`];
    for (const record of records) {
      lines.push(`  ${record.agent.padEnd(7)} ${record.dir}`);
      for (const file of record.files) lines.push(`    ${file.path} (${file.bytes} bytes)`);
    }
    if (values["no-verify"]) {
      lines.push("  verify  skipped (--no-verify)");
    } else if (verified) {
      lines.push(`  verify  ok (${verifyResults.length} install${verifyResults.length === 1 ? "" : "s"}, frontmatter valid, references present)`);
    } else {
      lines.push(`  verify  FAILED: ${failedVerify.flatMap((v) => v.problems).join("; ")}`);
    }
    humanLines(lines, ctx);
  }

  if (failedVerify.length > 0) return 1;
  return 0;
}
