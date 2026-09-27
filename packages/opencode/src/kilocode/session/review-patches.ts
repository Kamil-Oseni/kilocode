import path from "node:path"
import { Effect } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"

const canonical = (file: string, directory: string) => {
  const absolute = path.resolve(directory, file)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

/** Read legacy patch claims through the immutable snapshots of their own completed step. */
export const project = Effect.fn("ReviewPatches.project")(function* (
  snap: Snapshot.Interface,
  messages: readonly MessageV2.WithParts[],
  directory: string,
) {
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      let start: string | undefined
      let finish: string | undefined
      const parts: MessageV2.Part[] = []
      for (const part of message.parts) {
        if (part.type === "step-start") {
          start = part.snapshot
          finish = undefined
        }
        if (part.type === "step-finish") finish = part.snapshot
        if (part.type !== "patch") {
          parts.push(part)
          continue
        }
        const diff =
          start && finish && part.hash === start
            ? yield* snap.patch(start, finish).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            : undefined
        const allowed = new Set((diff?.files ?? []).map((file) => canonical(file, directory)))
        parts.push({ ...part, files: part.files.filter((file) => allowed.has(canonical(file, directory))) })
        start = undefined
        finish = undefined
      }
      return { ...message, parts }
    }),
  )
})
