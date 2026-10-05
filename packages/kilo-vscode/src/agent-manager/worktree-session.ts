import type { SessionProvider } from "./host"
import type { Worktree } from "./WorktreeStateManager"
import type { WorktreeManager } from "./WorktreeManager"

/** Creation owns the metadata publication as well as the visible session route. */
export async function registerWorktreeSession(
  sid: string,
  dir: string,
  deps: {
    worktree?: Worktree
    manager?: WorktreeManager
    sessions?: SessionProvider
    failure: (err: unknown) => void
    log: (...args: unknown[]) => void
  },
): Promise<void> {
  const worktree = deps.worktree
  const pending =
    worktree && deps.manager
      ? deps.manager.writeMetadata(worktree.path, sid, worktree.parentBranch, worktree.remote).catch((err) => {
          deps.failure(err)
          deps.log(`Failed to write worktree metadata for ${worktree.id}:`, err)
        })
      : Promise.resolve()
  try {
    deps.sessions?.setSessionDirectory(sid, dir)
    deps.sessions?.trackSession(sid)
    deps.sessions?.recoverPendingPrompts()
  } finally {
    await pending
  }
}
