import path from "node:path"
import { Effect, Schedule, type FileSystem } from "effect"

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
        // Windows readers can briefly deny replacement even though they opened only for read.
        // Retrying the same staged rename preserves the old or new complete receipt on disk.
        yield* fs
          .rename(temp, target)
          .pipe(Effect.retry({ times: process.platform === "win32" ? 100 : 0, schedule: Schedule.spaced(10) }))
        return true
      }
      return yield* fs.link(temp, target).pipe(
        Effect.as(true),
        Effect.catch((error) => (error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error))),
      )
    }),
  )
}
