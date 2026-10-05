import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import type { InstanceContext } from "@/project/instance-context"

/** Derive the same concrete repository before lazy Snapshot state initialization. */
export function scope(ctx: InstanceContext) {
  const worktree =
    ctx.worktree === "/" || ctx.worktree === "global" || !path.isAbsolute(ctx.worktree) ? ctx.directory : ctx.worktree
  return { worktree, gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(worktree)) }
}

/** The existing data namespace admits initial directory creation; inner repository pins are separate. */
export function input(ctx: InstanceContext) {
  return { namespaces: [Global.Path.data], targets: [scope(ctx).gitdir] }
}
