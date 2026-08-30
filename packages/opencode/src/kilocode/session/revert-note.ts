// raya_change - after "Undo all" / per-file discard, tell the model on its next turn that its
// edits were reverted. Undo restores files but leaves the conversation intact, so the model's
// history still shows the edits it made and it will otherwise trust that stale context — e.g.
// claim a change is still present, or refuse to redo it. This note nudges it to re-read.

export namespace RayaRevertNote {
  // Pending revert notes keyed by sessionID. discardChanges records here; the prompt reminder
  // path reads and clears it so the note is injected exactly once. Both run in the same backend
  // process, so a module-level Map (mirroring RayaDesignSystem's process cache) is enough — the
  // note is ephemeral guidance and does not need to survive a restart.
  const pending = new Map<string, string[]>()

  // Record the files a user-initiated discard just restored, to surface on the next turn.
  export function record(sessionID: string, files: readonly string[]): void {
    if (files.length === 0) return
    const prev = pending.get(sessionID) ?? []
    pending.set(sessionID, [...new Set([...prev, ...files])])
  }

  // Read and clear the pending note for a session. Returns undefined when there is none.
  export function take(sessionID: string): string[] | undefined {
    const files = pending.get(sessionID)
    if (!files || files.length === 0) return undefined
    pending.delete(sessionID)
    return files
  }

  // Reminder text for the reverted files, or undefined when there is nothing to report.
  export function reminder(files: string[] | undefined): string | undefined {
    if (!files || files.length === 0) return undefined
    const base = (file: string) => file.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? file
    const shown = files.slice(0, 20).map(base).join(", ")
    const more = files.length > 20 ? ` (and ${files.length - 20} more)` : ""
    return [
      "<system-reminder>",
      "## Reverted Changes",
      `The user just undid your file edits. These files were restored to their state before your edits: ${shown}${more}.`,
      "Do not assume your earlier edits to these files still exist. Re-read a file before acting on it, and if the user asks you to make the change again, actually re-apply it instead of claiming it is already there.",
      "</system-reminder>",
    ].join("\n")
  }
}
