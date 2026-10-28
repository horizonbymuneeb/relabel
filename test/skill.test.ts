import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentRoots,
  effectiveRoots,
  installSkill,
  parseFrontmatter,
  run,
  verifyInstall,
} from "../dist/skill.js";
import type { Ctx } from "../dist/types.js";

function makeCtx(json = false): Ctx & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd: process.cwd(),
    json,
    version: "0.1.0-test",
    log: (msg: string) => lines.push(msg),
    error: (msg: string) => errors.push(msg),
    lines,
    errors,
  };
}

async function captureJson<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = original;
  }
}

test("skill install writes SKILL.md + references into --prefix and verifies them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-skill-"));
  try {
    const ctx = makeCtx(false);
    const code = await run(["install", "--agent", "claude", "--prefix", dir], ctx);
    assert.equal(code, 0, ctx.errors.join("; "));

    const skill = path.join(dir, "relabel", "SKILL.md");
    assert.ok(existsSync(skill), `missing ${skill}`);
    const text = await readFile(skill, "utf8");
    const fm = parseFrontmatter(text);
    assert.equal(fm.data.name, "relabel");
    assert.equal(typeof fm.data.description, "string");
    assert.ok((fm.data.description as string).length > 10);
    assert.match(fm.body, /relabeld/);
    assert.match(fm.body, /relabeld verify/);
    assert.match(fm.body, /skill install/);

    const refs = (await readdir(path.join(dir, "relabel", "references"))).filter((f) => f.endsWith(".md"));
    assert.ok(refs.length >= 2, `expected references, found ${refs.join(", ")}`);
    assert.ok(refs.includes("verification.md"));
    assert.ok(refs.includes("mcp.md"));

    assert.ok(
      ctx.lines.some((l) => /verify\s+ok/.test(l)),
      `human output should confirm verification: ${ctx.lines.join(" | ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill install --agent all installs for all three agents and prints one JSON object", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-skill-all-"));
  try {
    const ctx = makeCtx(true);
    const { value: code, logs } = await captureJson(() =>
      run(["install", "--agent", "all", "--prefix", dir, "--json"], ctx),
    );
    assert.equal(code, 0, ctx.errors.join("; "));
    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0]) as {
      installed: Array<{ agent: string; root: string; files: Array<{ path: string; bytes: number }> }>;
      verified: boolean | null;
      verification: Array<{ ok: boolean; references: number }>;
    };
    assert.deepEqual(payload.installed.map((i) => i.agent), ["claude", "codex", "dsh"]);
    assert.equal(payload.verified, true);
    assert.ok(payload.verification.every((v) => v.ok && v.references >= 2));
    for (const agent of ["claude", "codex", "dsh"]) {
      assert.ok(payload.installed.find((i) => i.agent === agent));
    }
    assert.ok(payload.installed[0].files.some((f) => f.path === "SKILL.md" && f.bytes > 500));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill list prints the default agent → root map", async () => {
  const ctx = makeCtx(true);
  const { value: code, logs } = await captureJson(() => run(["list", "--json"], ctx));
  assert.equal(code, 0);
  assert.equal(logs.length, 1);
  const payload = JSON.parse(logs[0]) as { roots: Record<string, string>; agents: string[] };
  assert.deepEqual(payload.agents, ["claude", "codex", "dsh"]);
  assert.match(payload.roots.claude, /\.claude[\\/]skills$/);
  assert.match(payload.roots.codex, /\.codex[\\/]skills$/);
  assert.match(payload.roots.dsh, /\.dsh-home[\\/]skills$/);

  const human = makeCtx(false);
  assert.equal(await run(["--list", "--prefix", "/tmp/relabel-map"], human), 0);
  const text = human.lines.join("\n");
  assert.match(text, /claude\s+\/tmp\/relabel-map/);
  assert.match(text, /codex\s+\/tmp\/relabel-map/);
  assert.match(text, /dsh\s+\/tmp\/relabel-map/);
});

test("skill defaults and prefix resolution", () => {
  const roots = agentRoots("/home/tester");
  assert.equal(roots.claude, path.join("/home/tester", ".claude", "skills"));
  assert.equal(roots.codex, path.join("/home/tester", ".codex", "skills"));
  assert.equal(roots.dsh, path.join("/home/tester", ".dsh-home", "skills"));
  const prefixed = effectiveRoots("/tmp/skills", "/home/tester");
  assert.deepEqual(prefixed, { claude: "/tmp/skills", codex: "/tmp/skills", dsh: "/tmp/skills" });
});

test("skill install --no-verify skips verification", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-skill-noverify-"));
  try {
    const ctx = makeCtx(true);
    const { value: code, logs } = await captureJson(() =>
      run(["install", "--agent", "codex", "--prefix", dir, "--no-verify", "--json"], ctx),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(logs[0]) as { verified: null; verification: unknown[] };
    assert.equal(payload.verified, null);
    assert.deepEqual(payload.verification, []);
    assert.ok(existsSync(path.join(dir, "relabel", "SKILL.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill errors: unknown agent, missing agent, unknown subcommand exit 2", async () => {
  const ctx = makeCtx(false);
  assert.equal(await run(["install", "--agent", "vim"], ctx), 2);
  assert.equal(await run(["install"], ctx), 2);
  assert.equal(await run(["frobnicate"], ctx), 2);
  assert.equal(await run([], ctx), 2);
  assert.ok(ctx.errors.length >= 4);
});

test("verifyInstall detects broken frontmatter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-skill-broken-"));
  try {
    const record = await installSkill("claude", dir);
    assert.equal((await verifyInstall(record)).ok, true);
    await writeFile(path.join(dir, "relabel", "SKILL.md"), "# No frontmatter\njust text\n", "utf8");
    const broken = await verifyInstall(record);
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some((p) => p.includes("name")));
    assert.ok(broken.problems.some((p) => p.includes("description")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill install is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relabel-skill-idem-"));
  try {
    const ctx = makeCtx(false);
    assert.equal(await run(["install", "--agent", "dsh", "--prefix", dir], ctx), 0);
    const first = await readFile(path.join(dir, "relabel", "SKILL.md"), "utf8");
    assert.equal(await run(["install", "--agent", "dsh", "--prefix", dir], ctx), 0);
    const second = await readFile(path.join(dir, "relabel", "SKILL.md"), "utf8");
    assert.equal(first, second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
