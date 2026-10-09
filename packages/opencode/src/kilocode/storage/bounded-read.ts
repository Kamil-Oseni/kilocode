import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Option, Schema } from "effect"

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("RayaStorage.LimitError", {
  message: Schema.String,
}) {}

/** Read one opened file, including at most one byte beyond the caller's budget. */
export function read(fs: FSUtil.Interface, target: string, maximum: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum >= Number.MAX_SAFE_INTEGER) {
        return yield* Effect.fail(new LimitError({ message: "Storage byte limit must be a positive safe integer" }))
      }
      const file = yield* fs.open(target, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") {
        return yield* Effect.fail(new FSUtil.FileSystemError({ method: "readBounded", cause: "Expected a file" }))
      }
      const chunks: Uint8Array[] = []
      let total = 0
      while (total <= maximum) {
        const chunk = yield* file.readAlloc(Math.min(64 * 1024, maximum + 1 - total))
        if (Option.isNone(chunk) || chunk.value.length === 0) break
        chunks.push(chunk.value)
        total += chunk.value.length
      }
      if (total > maximum) {
        return yield* Effect.fail(new LimitError({ message: `Storage file exceeds ${maximum} bytes` }))
      }
      return yield* Effect.try({
        try: () =>
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown,
        catch: (cause) => new FSUtil.FileSystemError({ method: "readBounded", cause }),
      })
    }),
  )
}
