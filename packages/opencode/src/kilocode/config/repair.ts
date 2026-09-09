import path from "node:path"
import { createHash } from "node:crypto"
import { Cause, Effect, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Storage } from "@/storage/storage"
import { Outcome, repairs } from "@/kilocode/self-heal/repair"

const record = Schema.Struct({ owner: Schema.String, outcome: Outcome })
const normalize = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Suppress optional config writes, never grant execution or source ownership. */
export function setup(storage: Storage.Interface, fs: FSUtil.Interface, directory: string) {
  const id = path.basename(directory).toLowerCase()
  if (!/^[0-9a-f-]{36}$/.test(id)) return Effect.succeed(true)
  return Effect.gen(function* () {
    const canonical = yield* fs.realPath(directory)
    const keys = yield* storage.list(["raya", "self-heal", "repair"])
    for (const key of keys) {
      if (key.length !== 5 || key[4] !== "0") continue
      const first = yield* storage.read(key).pipe(Effect.flatMap(Schema.decodeUnknownEffect(record)))
      if (first.outcome.id !== id) continue
      if (key[3] !== createHash("sha256").update(first.outcome.itemID).digest("hex")) continue
      const current = yield* repairs(storage).get(first.outcome.itemID)
      if (
        current?.id === id &&
        current.worktree &&
        current.worktree.commit === current.source.commit &&
        normalize(current.worktree.directory) === normalize(canonical) &&
        normalize(path.join(current.worktree.root, id)) === normalize(canonical)
      )
        return false
    }
    return true
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause).pipe(Effect.orDie)
        : Effect.logWarning("Optional config setup deferred: repair ownership could not be inspected.", {
            directory,
          }).pipe(Effect.as(false)),
    ),
  )
}
