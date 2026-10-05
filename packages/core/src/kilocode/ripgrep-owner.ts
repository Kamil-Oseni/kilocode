import path from "node:path"
import { lstat } from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import { acquireProfileRoot, resolveProfileRoot } from "./profile-maintenance"
import { RuntimeRegistry } from "./runtime-registry"
import { registerProcessProfile } from "./process-profile"
import { Flock } from "../util/flock"
import type { FSUtil } from "../fs-util"

/** Join cleanup even after failure, retaining both actual causes. */
function settle<A, E, R, E2, R2>(body: Effect.Effect<A, E, R>, cleanup: Effect.Effect<void, E2, R2>) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(body))
      const final = yield* Effect.exit(cleanup)
      if (Exit.isFailure(exit) && Exit.isFailure(final))
        return yield* Effect.die(
          new AggregateError(
            [Cause.squash(exit.cause), Cause.squash(final.cause)],
            "Ripgrep operation and cleanup failed",
          ),
        )
      if (Exit.isFailure(final)) return yield* Effect.failCause(final.cause)
      return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
    }),
  )
}

/** One process participant for every compiled Core graph; unused import does not realize a writer. */
export function createOwner(registry = RuntimeRegistry) {
  const active = new Set<object>()
  const failures: unknown[] = []
  let installed = false
  let closed = false
  let closing: Promise<void> | undefined
  let finish: (() => void) | undefined
  const retire = () => {
    closed = true
    if (closing) return closing
    closing = new Promise<void>((resolve, reject) => {
      finish = () => {
        if (active.size) return
        if (failures.length) reject(new AggregateError(failures, "Ripgrep writer retirement failed"))
        else resolve()
      }
      finish()
    })
    return closing
  }
  const run = <A, E, R>(select: () => string, body: (root: string) => Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        registry.check()
        if (closed) throw new Error("Ripgrep writer admission is terminal")
        const selected = select()
        if (!path.isAbsolute(selected)) throw new Error("Ripgrep bin root must be absolute")
        if (!installed) {
          registry.register(retire)
          installed = true
        }
        const ticket = Object.freeze({})
        active.add(ticket)
        const work = Effect.gen(function* () {
          const root = yield* Effect.promise(() => resolveProfileRoot({ kind: "json", path: selected }))
          return yield* Effect.acquireUseRelease(
            Effect.promise((signal) => acquireProfileRoot(root, { signal })),
            () =>
              Effect.gen(function* () {
                const pin = yield* Effect.promise(() => lstat(root.path, { bigint: true }))
                if (!pin.isDirectory() || pin.isSymbolicLink())
                  return yield* Effect.die(new Error("Ripgrep bin root is not a regular directory"))
                const check = Effect.promise(async () => {
                  const current = await resolveProfileRoot({ kind: "json", path: selected })
                  const info = await lstat(root.path, { bigint: true })
                  if (
                    current.id !== root.id ||
                    !info.isDirectory() ||
                    info.isSymbolicLink() ||
                    info.dev !== pin.dev ||
                    info.ino !== pin.ino
                  )
                    throw new Error("Ripgrep bin root binding changed")
                })
                return yield* settle(
                  Effect.scoped(
                    Effect.gen(function* () {
                      yield* Flock.effect(`ripgrep-bin:${root.id}`, {
                        dir: path.join(root.path, ".raya-ripgrep-locks"),
                        recover: "dead",
                        timeoutMs: 30_000,
                      })
                      yield* check
                      yield* Effect.sync(() => registerProcessProfile([root.path]))
                      return yield* Effect.suspend(() => body(root.path))
                    }),
                  ),
                  check,
                )
              }),
            (lease) => Effect.promise(() => lease.release()),
          )
        })
        return restore(work).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) failures.push(exit.cause)
              active.delete(ticket)
              finish?.()
            }),
          ),
        )
      }),
    )
  return { run, retire, snapshot: () => ({ installed, closed, active: active.size, failures: failures.length }) }
}

export const ripgrep = createOwner()

/** Publish only a complete sibling executable; extraction and every cleanup stay in the caller's lease. */
export function publish(fs: FSUtil.Interface, source: string, target: string) {
  const stage = path.join(path.dirname(target), `.ripgrep-${crypto.randomUUID()}.tmp`)
  return settle(
    Effect.gen(function* () {
      yield* fs.copyFile(source, stage)
      if (process.platform !== "win32") yield* fs.chmod(stage, 0o755)
      yield* fs.rename(stage, target)
    }),
    fs.remove(stage, { force: true }),
  )
}

export const cleanup = settle
