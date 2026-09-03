import { Cause, Effect } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"

export namespace KiloSessionRevert {
  const rollback = <E>(snap: Snapshot.Interface, hash: string, files: string[], cause: Cause.Cause<E>) =>
    restore(snap, hash, files).pipe(
      Effect.matchCauseEffect({
        onFailure: (next) => Effect.failCause(Cause.combine(cause, next)),
        onSuccess: () => Effect.failCause(cause),
      }),
    )

  export function files(messages: MessageV2.WithParts[], rev: NonNullable<Session.Info["revert"]>) {
    const result: string[] = []
    let active = false
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (active && part.type === "patch") result.push(...part.files)
        if (active || msg.info.id !== rev.messageID) continue
        if (rev.partID && part.id !== rev.partID) continue
        active = true
      }
    }
    return [...new Set(result)]
  }

  export const apply = Effect.fn("KiloSessionRevert.apply")(function* <A, E, R>(
    snap: Snapshot.Interface,
    baseline: string | undefined,
    files: string[],
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* effect.pipe(
      Effect.catchCause((cause) => {
        if (!baseline || files.length === 0) return Effect.failCause(cause)
        return rollback(snap, baseline, files, cause)
      }),
    )
  })

  export const restore = Effect.fn("KiloSessionRevert.restore")(function* (
    snap: Snapshot.Interface,
    hash: string,
    files: string[],
  ) {
    if (files.length === 0) return
    yield* snap.revert([{ hash, files }])
  })

  // A patch file (absolute, worktree-joined, forward-slashed) matches a caller
  // filter when it equals the filter or ends with it as a path segment. Lets the
  // webview pass either an absolute path or a worktree-relative one for per-file
  // undo without the client needing to know the exact snapshot path form.
  const matches = (file: string, filter: Set<string>) => {
    if (filter.has(file)) return true
    for (const want of filter) if (file === want || file.endsWith(`/${want}`)) return true
    return false
  }

  /**
   * Discard file edits made in the session — without touching messages and
   * without arming a revert boundary (so nothing becomes "redoable").
   *
   * Every "patch" part records the snapshot hash captured *before* that turn's
   * edits, and belongs to a message whose id is globally monotonic. A `kept`
   * boundary (file → message id of that file's last kept edit, set by
   * `keepChanges` when the user clicks Keep / Keep all) fences off everything at
   * or before it: only edits *after* a file's boundary are undoable, so Undo can
   * never rewind past a point the user already accepted. The revert target then
   * depends on scope:
   *
   * - Workspace-wide "Undo all" (`only` omitted): revert each file to its state
   *   at the boundary — i.e. before its *earliest post-keep* edit. That patch's
   *   hash is the snapshot captured just before that edit, which is exactly the
   *   kept content. With no boundary this is the session's first edit (full
   *   rewind), preserving the original behavior.
   * - Per-file in-editor "Undo" (`only` set): step back a single edit — revert
   *   the file to the hash before its *most recent* post-keep edit, so undoing
   *   the newest change restores the previous content instead of deleting what
   *   earlier edits created.
   *
   * If a file has no edits after its boundary there is nothing to undo, so it is
   * skipped rather than rewound into kept (or pre-session) territory — this is
   * what stops Keep-all-then-Undo-all from wiping content the user already kept.
   *
   * The whole restore is wrapped so a mid-way failure rolls back to the current
   * (edited) state, keeping the operation atomic.
   */
  export const discardAll = Effect.fn("KiloSessionRevert.discardAll")(function* (
    snap: Snapshot.Interface,
    messages: MessageV2.WithParts[],
    only?: string[],
    kept?: Record<string, string>,
  ) {
    const filter = only && only.length > 0 ? new Set(only.map((file) => file.replaceAll("\\", "/"))) : undefined
    // raya_change - group each file's patches in message order, then honor the kept boundary and
    // scope. Undo-all targets the earliest still-undoable edit (= kept content); per-file Undo
    // targets the most recent one (step back exactly one edit). A file with nothing after its
    // boundary is skipped so accepted work is never rewound.
    const perFile = new Map<string, { id: string; hash: string }[]>()
    for (const msg of messages)
      for (const part of msg.parts)
        if (part.type === "patch")
          for (const file of part.files) {
            const norm = file.replaceAll("\\", "/")
            if (filter && !matches(norm, filter)) continue
            const list = perFile.get(file) ?? (perFile.set(file, []), perFile.get(file)!)
            list.push({ id: msg.info.id, hash: part.hash })
          }
    const patches: Snapshot.Patch[] = []
    for (const [file, list] of perFile) {
      const boundary = kept?.[file.replaceAll("\\", "/")]
      const eligible = boundary ? list.filter((patch) => patch.id > boundary) : list
      if (eligible.length === 0) continue
      const target = filter ? eligible[eligible.length - 1]! : eligible[0]!
      patches.push({ hash: target.hash, files: [file] })
    }
    const files = [...new Set(patches.flatMap((patch) => patch.files))]
    if (files.length === 0) return { files: [] as string[] }
    const baseline = yield* snap.track()
    if (!baseline)
      return yield* Effect.die(new Error("Cannot discard changes because the current workspace snapshot is unavailable"))
    yield* apply(snap, baseline, files, snap.revert(patches))
    return { files }
  })
}
