import path from "node:path"
import { lstat, mkdir } from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import { Global } from "@opencode-ai/core/global"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import type { SnapshotRuntime } from "./runtime"

/** A retained physical generation check; actual runtime operations supply temporal lease authority. */
export namespace SnapshotPin {
  type Ownership = Pick<ReturnType<typeof SnapshotRuntime.install>, "run">

  export function make(dir: string) {
    const selected = path.resolve(dir)
    let bound: Awaited<ReturnType<typeof capture>> | undefined
    async function capture() {
      const root = await resolveProfileRoot({ kind: "json", path: selected })
      const info = await lstat(root.path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Snapshot repository is not a regular directory")
      return { id: root.id, path: root.path, dev: info.dev, ino: info.ino }
    }
    const check = async () => {
      const current = await capture()
      if (!bound) {
        bound = current
        return
      }
      if (
        current.id !== bound.id ||
        current.path !== bound.path ||
        current.dev !== bound.dev ||
        current.ino !== bound.ino
      )
        throw new Error("Snapshot repository physical generation changed")
    }
    const run = <A, E, R>(ownership: Ownership, body: Effect.Effect<A, E, R>) =>
      ownership.run(
        { namespaces: [selected] },
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* Effect.promise(check)
            const exit = yield* Effect.exit(restore(body))
            const checked = yield* Effect.exit(Effect.promise(check))
            if (Exit.isFailure(exit) && Exit.isFailure(checked))
              return yield* Effect.die(
                new AggregateError(
                  [Cause.squash(exit.cause), Cause.squash(checked.cause)],
                  "Snapshot repository body and binding failed",
                ),
              )
            if (Exit.isFailure(checked)) return yield* Effect.failCause(checked.cause)
            return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
          }),
        ),
      )
    const bootstrap = <A, E, R>(ownership: Ownership, body: Effect.Effect<A, E, R>) =>
      ownership.run(
        { namespaces: [Global.Path.data], targets: [selected] },
        Effect.gen(function* () {
          if (bound) return yield* run(ownership, body)
          const exists = yield* Effect.promise(() =>
            lstat(selected).then(
              () => true,
              (err: unknown) => {
                if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return false
                throw err
              },
            ),
          )
          if (!exists) {
            yield* Effect.promise(() => mkdir(path.dirname(selected), { recursive: true }))
            // The exact leaf is exclusive: a raced EEXIST never becomes an adopted initial generation.
            yield* Effect.promise(() => mkdir(selected))
            bound = yield* Effect.promise(capture)
          }
          return yield* run(ownership, body)
        }),
      )
    return { run, bootstrap }
  }
}
