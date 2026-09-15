// raya_change - after "Undo all" / per-file discard, tell the model on its next turn that its
// edits were reverted. Undo restores files but leaves the conversation intact, so the model's
// history still shows the edits it made and it will otherwise trust that stale context — e.g.
// claim a change is still present, or refuse to redo it. This note nudges it to re-read.
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"

export namespace RayaRevertNote {
  // In-process cache plus a small JSON file so the note survives a backend restart
  // (common after a VSIX reinstall / window reload) between undo and the next prompt.
  const pending = new Map<string, string[]>()

  const dest = (sessionID: string) => path.join(Global.Path.data, "raya", "revert-note", `${sessionID}.json`)

  const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

  const readDisk = (file: string): string[] => {
    if (!fs.existsSync(file)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  }

  const writeDisk = (file: string, files: readonly string[]) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify([...files]))
  }

  const dropDisk = (file: string) => {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  // Record the files a user-initiated discard just restored, to surface on the next turn.
  export async function record(
    sessionID: string,
    files: readonly string[],
    admission: ProfileWriterLive.Admission = ProfileWriterLive.revertNote,
  ): Promise<void> {
    if (files.length === 0) return
    await Effect.runPromise(
      admission.run(
        Effect.sync(() => {
          const file = dest(sessionID)
          const next = merge(pending.get(file) ?? readDisk(file), files)
          pending.set(file, next)
          writeDisk(file, next)
        }),
      ),
    )
  }

  // Read and clear the pending note for a session. Returns undefined when there is none.
  export async function take(
    sessionID: string,
    admission: ProfileWriterLive.Admission = ProfileWriterLive.revertNote,
  ): Promise<string[] | undefined> {
    return Effect.runPromise(
      admission.run(
        Effect.sync(() => {
          const file = dest(sessionID)
          const files = merge(pending.get(file) ?? [], readDisk(file))
          pending.delete(file)
          dropDisk(file)
          if (files.length === 0) return undefined
          return files
        }),
      ),
    )
  }

  // Test-only: drop the in-process cache so the next take() must read the persisted file.
  export function dropCache(): void {
    pending.clear()
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
