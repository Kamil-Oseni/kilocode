import type { Worktree } from "./WorktreeStateManager"

export function directories(worktrees: Pick<Worktree, "path">[] | undefined) {
  return worktrees?.map((wt) => wt.path) ?? []
}

export function scopes(root: string | undefined, worktrees: Pick<Worktree, "id" | "path">[]) {
  return [
    ...(root
      ? [
          { box: "agent-manager:unassigned", directory: root },
          { box: "agent-manager:local", directory: root },
        ]
      : []),
    ...worktrees.map((wt) => ({ box: `agent-manager:${wt.id}`, directory: wt.path })),
  ]
}
