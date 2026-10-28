import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, prepareCall, TOOL_DEFINITIONS } from "../dist/mcp.js";
import type { Ctx } from "../dist/types.js";

const EXPECTED_TOOLS = [
  "relabel_scan",
  "relabel_init",
  "relabel_apply",
  "relabel_verify",
  "relabel_report",
];

function makeCtx(cwd: string): Ctx {
  return { cwd, json: false, version: "0.1.0-test", log: () => undefined, error: () => undefined };
}

async function wc(buf: string): Promise<string[]> {
  return buf.split("\n").filter((line) => line.trim().length > 0);
}

test("tools/list returns exactly the five relabel tools", async () => {
  const server = createServer(makeCtx(process.cwd()));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "relabel-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, "relabeld");
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 5, "exactly five tools");
    assert.deepEqual(
      listed.tools.map((t) => t.name).sort(),
      [...EXPECTED_TOOLS].sort(),
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    }
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), EXPECTED_TOOLS);
  } finally {
    await client.close();
    await server.close();
  }
});

test("tools/call relabel_report runs the CLI and returns its JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-mcp-report-"));
  try {
    const input = path.join(dir, "verify.json");
    const out = path.join(dir, "report.html");
    await writeFile(
      input,
      JSON.stringify({
        url: "https://status.example.com/",
        brandName: "Nova Status",
        checks: [
          { id: "brand-strings", title: "old brand strings absent", status: "pass", detail: "0 occurrences" },
          { id: "favicon", title: "favicon matches brand asset", status: "skip", detail: "not configured" },
        ],
        screenshots: [],
        summary: { passed: 1, failed: 0, skipped: 1 },
        generatedAt: "2026-10-29T00:00:00.000Z",
      }),
      "utf8",
    );

    const server = createServer(makeCtx(process.cwd()));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "relabel-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "relabel_report",
        arguments: { input, out },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const payload = JSON.parse(result.content[0].text) as { out: string; bytes: number };
      assert.equal(payload.out, out);
      assert.ok(payload.bytes > 100);
      const html = await readFile(out, "utf8");
      assert.match(html, /Nova Status/);
      assert.equal((html.match(/https?:\/\//gi) ?? []).length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bad tool calls return MCP tool errors instead of crashing", async () => {
  const server = createServer(makeCtx(process.cwd()));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "relabel-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const missingUrl = (await client.callTool({ name: "relabel_verify", arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(missingUrl.isError, true);
    assert.match(missingUrl.content[0].text, /requires a `url`/);

    const missingOut = (await client.callTool({
      name: "relabel_report",
      arguments: { input: "/tmp/x.json" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(missingOut.isError, true);
    assert.match(missingOut.content[0].text, /requires `out`/);

    const unknown = (await client.callTool({ name: "relabel_nope", arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown tool/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("prepareCall maps tool arguments to CLI argv", () => {
  const cwd = "/work/project";
  assert.deepEqual(prepareCall("relabel_scan", {}, cwd), { args: ["scan", ".", "--json"], cwd });
  assert.deepEqual(prepareCall("relabel_scan", { root: "app", cwd: "sub" }, cwd), {
    args: ["scan", "app", "--json"],
    cwd: "/work/project/sub",
  });
  const init = prepareCall("relabel_init", { name: "Nova Status", domain: "status.example.com" }, cwd);
  assert.ok(Array.isArray(init) === false);
  assert.deepEqual((init as { args: string[] }).args, [
    "init",
    "--name",
    "Nova Status",
    "--domain",
    "status.example.com",
    "--json",
  ]);
  const apply = prepareCall("relabel_apply", { dryRun: true }, cwd);
  assert.deepEqual((apply as { args: string[] }).args, ["apply", "--dry-run", "--json"]);
  const verify = prepareCall("relabel_verify", { url: "http://x/", cdp: "ws://y" }, cwd);
  assert.deepEqual((verify as { args: string[] }).args, [
    "verify",
    "--url",
    "http://x/",
    "--cdp",
    "ws://y",
    "--json",
  ]);
  assert.equal(typeof prepareCall("relabel_init", {}, cwd), "string");
});

test("mcp stdio process writes only protocol JSON to stdout", async () => {
  const cli = path.join(process.cwd(), "dist", "cli.js");
  const child = spawn(process.execPath, [cli, "mcp"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  try {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "0" },
      },
    };
    child.stdin.write(JSON.stringify(initialize) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

    const lines = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`)), 15_000);
      const check = () => {
        const nonEmpty = stdout.split("\n").filter((l) => l.trim().length > 0);
        if (nonEmpty.length >= 2) {
          clearTimeout(timer);
          resolve(nonEmpty);
        }
      };
      child.stdout.on("data", check);
      check();
    });

    const responses = lines.map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    assert.equal(responses[0].id, 1);
    assert.ok((responses[0].result as { protocolVersion?: string }).protocolVersion);
    assert.equal(responses[1].id, 2);
    const tools = (responses[1].result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 5);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    // stdout had exactly the two responses, each a parseable JSON-RPC object.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0");
    }
    assert.equal(lines.length, 2, `unexpected extra stdout lines: ${JSON.stringify(lines)}`);
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
});
