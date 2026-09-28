import path from "node:path"
import type { Effect } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { ReviewGate } from "./review-gate"

/** Serialize publication of new work with review; callers await execution after this effect. */
export function admission(gate: ReviewGate.Interface, ctx: InstanceContext) {
  const root =
    ctx.worktree === "/" || ctx.worktree === "global" || !path.isAbsolute(ctx.worktree) ? ctx.directory : ctx.worktree
  return <A, E, R>(body: Effect.Effect<A, E, R>) => gate.withWorkspaces([ctx.directory, root])(body)
}
