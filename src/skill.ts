import type { Ctx } from "./types.js";

export async function run(_argv: string[], ctx: Ctx): Promise<number> {
  ctx.log("skill: not implemented yet (v" + ctx.version + ")");
  return 2;
}
