import path from "node:path"
import { Effect, type FileSystem } from "effect"

/** Publish complete receipt bytes; hard-link claims cannot replace another owner's record. */
export function publish(fs: FileSystem.FileSystem, target: string, content: unknown, replace = false) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      const temp = yield* fs.makeTempFileScoped({ directory: path.dirname(target), prefix: ".review-", suffix: ".tmp" })
      yield* fs.writeFileString(temp, JSON.stringify(content))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temp, { flag: "r+" })
          yield* file.sync
        }),
      )
      if (replace) {
        yield* fs.rename(temp, target)
        return true
      }
      return yield* fs.link(temp, target).pipe(
        Effect.as(true),
        Effect.catch((error) => (error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error))),
      )
    }),
  )
}
