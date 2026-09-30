import type { DraftEntry } from "../../src/shared/composer-drafts-messages"

export function pendingCatalog(entries: DraftEntry[], box: string): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.identity.box === box && entry.content !== null && entry.identity.pendingID
          ? [entry.identity.pendingID]
          : [],
      ),
    ),
  ]
}

export interface NewTaskDraft {
  id: string
  worktreeId: string
  owner?: string
}

export function createNewTaskDrafts(timeout = 30_000) {
  const tasks = new Map<string, NewTaskDraft[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const key = (worktreeId: string, owner?: string) => JSON.stringify([owner ?? null, worktreeId])

  const remove = (task: NewTaskDraft, discard = false) => {
    const scope = key(task.worktreeId, task.owner)
    const ids = tasks.get(scope) ?? []
    const next = ids.filter((item) => item.id !== task.id)
    if (next.length === 0) tasks.delete(scope)
    else tasks.set(scope, next)
    const timer = timers.get(task.id)
    if (timer) clearTimeout(timer)
    timers.delete(task.id)
    if (!discard) return
    window.dispatchEvent(new CustomEvent("agentManagerDiscardDraft", { detail: { id: task.id, owner: task.owner } }))
  }

  const create = (worktreeId: string, owner?: string) => {
    const task = { id: crypto.randomUUID(), worktreeId, owner }
    const scope = key(worktreeId, owner)
    tasks.set(scope, [...(tasks.get(scope) ?? []), task])
    timers.set(
      task.id,
      setTimeout(() => remove(task, true), timeout),
    )
    return task
  }

  const take = (worktreeId: string, owner: string | undefined, requestID: string | undefined) => {
    if (!requestID) return undefined
    const task = tasks.get(key(worktreeId, owner))?.find((item) => item.id === requestID)
    if (!task) return undefined
    remove(task)
    return task
  }

  const cleanup = () => {
    for (const ids of tasks.values()) {
      for (const task of ids) {
        window.dispatchEvent(
          new CustomEvent("agentManagerDiscardDraft", { detail: { id: task.id, owner: task.owner } }),
        )
      }
    }
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    tasks.clear()
  }

  const apply = (worktreeId: string, sessionId: string, owner?: string, requestID?: string) => {
    const task = take(worktreeId, owner, requestID)
    if (!task) return
    window.dispatchEvent(
      new CustomEvent("agentManagerApplyDraft", {
        detail: { id: task.id, sessionId, boxId: `agent-manager:${worktreeId}`, owner: task.owner },
      }),
    )
  }

  return { create, apply, cleanup }
}
