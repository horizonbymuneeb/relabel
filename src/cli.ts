#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { Ctx } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

const COMMANDS: Record<string, { file: string; desc: string }> = {
  scan: { file: "./scan.js", desc: "detect brand surfaces in a repo/app (read-only)" },
  init: { file: "./init.js", desc: "create brand.yaml from scan + flags" },
  apply: { file: "./apply.js", desc: "patch strings/assets/compose from brand.yaml" },
  verify: { file: "./verify.js", desc: "headless proof: brand strings, console, overflow, screenshots" },
  report: { file: "./report.js", desc: "render a self-contained HTML report from verify JSON" },
  recipe: { file: "./recipes.js", desc: "list/show/add app recipes" },
  doctor: { file: "./doctor.js", desc: "check local environment (node, docker, browser, deploy tools)" },
  deploy: { file: "./deploy.js", desc: "nginx vhost + Cloudflare DNS + cert (opt-in)" },
  mcp: { file: "./mcp.js", desc: "start the MCP stdio server" },
  skill: { file: "./skill.js", desc: "install the agent skill (claude/codex/dsh/all)" },
};

const HELP = [
  "relabeld — white-label any self-hosted app, deterministically, with proof.",
  "",
  "Usage: relabeld <command> [options]",
  "",
  "Commands:",
  ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(8)} ${c.desc}`),
  "",
  "Global options:",
  "  --json            machine-readable output",
  "  --cwd <dir>       working directory (default: .)",
  "  -h, --help        show help",
  "  -v, --version     show version",
].join("\n");

export function makeCtx(opts: { cwd?: string; json?: boolean }): Ctx {
  return {
    cwd: opts.cwd ?? process.cwd(),
    json: Boolean(opts.json),
    log: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
    version: pkgVersion(),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean", default: false },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    console.error(String(err));
    return 1;
  }

  const values = parsed.values as { json?: boolean; cwd?: string; help?: boolean; version?: boolean };
  if (values.version) {
    console.log(pkgVersion());
    return 0;
  }
  const positionals = parsed.positionals as string[];
  const command = positionals[0];
  if (!command || values.help && !COMMANDS[command]) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    return 2;
  }

  const ctx = makeCtx({ cwd: values.cwd, json: values.json });
  const mod = (await import(entry.file)) as { run: (argv: string[], ctx: Ctx) => Promise<number> };
  const rest = argv.slice(argv.indexOf(command) + 1);
  return mod.run(rest, ctx);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? String(err));
      process.exit(1);
    });
}
