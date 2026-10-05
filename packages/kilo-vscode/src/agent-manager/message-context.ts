import { remoteRef, type WorktreeStateManager } from "./WorktreeStateManager"

/** Read-only enrichment remains separate from admitted worktree mutations. */
export async function contextMessage(
  msg: Record<string, unknown>,
  deps: {
    target: (ctx: string) => Promise<Record<string, unknown> | undefined>
    active: () => string | undefined
    state: () => WorktreeStateManager | undefined
  },
): Promise<Record<string, unknown>> {
  if (msg.type !== "requestGitChangesContext") return msg
  const ctx = typeof msg.agentManagerContext === "string" ? msg.agentManagerContext : undefined
  const target = ctx ? await deps.target(ctx) : undefined
  const sid = typeof msg.sessionID === "string" ? msg.sessionID : deps.active()
  const next = sid && typeof msg.sessionID !== "string" ? { ...msg, sessionID: sid } : msg
  if (target) return { ...next, ...target }
  if (!sid) return next
  const state = deps.state()
  const session = state?.getSession(sid)
  const worktree = session?.worktreeId ? state?.getWorktree(session.worktreeId) : undefined
  if (!worktree) return next
  return { ...next, contextDirectory: worktree.path, gitChangesBase: remoteRef(worktree) }
}
