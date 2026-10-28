import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Ctx } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "Usage: relabeld mcp",
  "",
  "Starts the relabeld MCP stdio server exposing five tools:",
  "  relabel_scan, relabel_init, relabel_apply, relabel_verify, relabel_report",
  "",
  "Nothing but MCP protocol JSON is written to stdout; diagnostics go to stderr.",
].join("\n");

interface JsonSchema {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "relabel_scan",
    description:
      "Scan a self-hosted app repo for brand surfaces (strings, assets, env defaults, docs) without modifying anything. Returns ScanResult JSON.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repo/directory to scan (default: the server's working directory)." },
        cwd: { type: "string", description: "Working directory for the command (default: the server's working directory)." },
      },
      required: [],
    },
  },
  {
    name: "relabel_init",
    description:
      "Create a brand.yaml from a scan and the given branding flags. Non-destructive: refuses to overwrite an existing brand.yaml unless force is set.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New brand name, e.g. \"Nova Status\"." },
        domain: { type: "string", description: "Brand domain, e.g. status.example.com." },
        from: { type: "string", description: "Source directory to initialise from (default: working directory)." },
        force: { type: "boolean", description: "Overwrite an existing brand.yaml." },
        cwd: { type: "string", description: "Working directory for the command." },
      },
      required: ["name"],
    },
  },
  {
    name: "relabel_apply",
    description:
      "Apply the brand defined in brand.yaml to the app (strings, assets, env, compose). Deterministic; supports dry-run.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Only report what would change." },
        cwd: { type: "string", description: "Working directory containing brand.yaml." },
      },
      required: [],
    },
  },
  {
    name: "relabel_verify",
    description:
      "Prove a deployment by running headless Chromium: old-brand strings absent, new brand in <title>, zero console errors, zero horizontal overflow at 1440x980 and 390x844, screenshots saved, favicon hash match. Returns VerifyResult JSON.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Deployed URL to verify." },
        brand: { type: "string", description: "Path to brand.yaml (default: brand.yaml in cwd)." },
        shots: { type: "string", description: "Screenshot output directory (default: .relabel/verify)." },
        cdp: { type: "string", description: "Attach to an existing Chromium over CDP instead of launching one." },
        cwd: { type: "string", description: "Working directory for the command." },
      },
      required: ["url"],
    },
  },
  {
    name: "relabel_report",
    description:
      "Render a self-contained HTML verification report (inline CSS, base64 screenshots, no external references) from a VerifyResult JSON file.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Path to the VerifyResult JSON file." },
        out: { type: "string", description: "Path to write the report HTML." },
        cwd: { type: "string", description: "Working directory for the command." },
      },
      required: ["input", "out"],
    },
  },
];

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the relabeld CLI with JSON output and capture both streams. */
export function execCli(args: string[], cwd: string): Promise<CliResult> {
  const cli = path.join(HERE, "cli.js");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += String(err);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

interface PreparedCall {
  args: string[];
  cwd: string;
}

/** Translate a tool call into CLI argv. Returns a string error on bad input. */
export function prepareCall(
  name: string,
  args: Record<string, unknown>,
  defaultCwd: string,
): PreparedCall | string {
  const cwd = str(args, "cwd") ? path.resolve(defaultCwd, str(args, "cwd")!) : defaultCwd;
  switch (name) {
    case "relabel_scan": {
      const root = str(args, "root") ?? ".";
      return { args: ["scan", root, "--json"], cwd };
    }
    case "relabel_init": {
      const brandName = str(args, "name");
      if (!brandName) return "relabel_init requires a non-empty `name`";
      const cliArgs = ["init", "--name", brandName];
      if (str(args, "domain")) cliArgs.push("--domain", str(args, "domain")!);
      if (str(args, "from")) cliArgs.push("--from", str(args, "from")!);
      if (bool(args, "force")) cliArgs.push("--force");
      cliArgs.push("--json");
      return { args: cliArgs, cwd };
    }
    case "relabel_apply": {
      const cliArgs = ["apply"];
      if (bool(args, "dryRun")) cliArgs.push("--dry-run");
      cliArgs.push("--json");
      return { args: cliArgs, cwd };
    }
    case "relabel_verify": {
      const url = str(args, "url");
      if (!url) return "relabel_verify requires a `url`";
      const cliArgs = ["verify", "--url", url];
      if (str(args, "brand")) cliArgs.push("--brand", str(args, "brand")!);
      if (str(args, "shots")) cliArgs.push("--shots", str(args, "shots")!);
      if (str(args, "cdp")) cliArgs.push("--cdp", str(args, "cdp")!);
      cliArgs.push("--json");
      return { args: cliArgs, cwd };
    }
    case "relabel_report": {
      const input = str(args, "input");
      const out = str(args, "out");
      if (!input) return "relabel_report requires `input`";
      if (!out) return "relabel_report requires `out`";
      return { args: ["report", "--input", input, "--out", out, "--json"], cwd };
    }
    default:
      return `unknown tool: ${name}`;
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Build (but do not connect) the MCP server. Exported for in-memory tests. */
export function createServer(ctx: Pick<Ctx, "cwd" | "version">): Server {
  const server = new Server(
    { name: "relabeld", version: ctx.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const prepared = prepareCall(name, args, ctx.cwd);
    if (typeof prepared === "string") {
      return textResult(prepared, true);
    }
    try {
      const result = await execCli(prepared.args, prepared.cwd);
      const stdout = result.stdout.trim();
      if (result.code === 0) {
        return textResult(stdout || "(no output)");
      }
      const stderr = result.stderr.trim();
      return textResult(
        `${name} failed with exit ${result.code}${stderr ? `:\n${stderr}` : ""}${stdout ? `\n${stdout}` : ""}`,
        true,
      );
    } catch (err) {
      return textResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  return server;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    return 0;
  }
  // MCP stdio: stdout is reserved for protocol JSON. Anything else goes to stderr.
  const toStderr = (...items: unknown[]) => {
    console.error(...items);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    transport.onclose = done;
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
  await server.close().catch(() => undefined);
  return 0;
}
