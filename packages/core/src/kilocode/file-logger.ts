import { Effect, Exit, FileSystem, Logger, Scope } from "effect"
import path from "node:path"
import { logRoot } from "./log-root"
import { RuntimeRegistry } from "./runtime-registry"

const owners = new Set<{ fence(): void; close(): Promise<void> }>()
let closed = false
let pending: Promise<void> | undefined

/** Run after runtime/database finalizers so their final log entries remain admissible. */
export function drainFileLoggers(): Promise<void> {
  closed = true
  if (pending) return pending
  for (const owner of owners) owner.fence()
  pending = Promise.allSettled([...owners].map((owner) => owner.close())).then((results) => {
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Effect file logger retirement failed")
    owners.clear()
  })
  return pending
}

/** Preserve the builtin real file/batch implementation, including its native scope finalizers. */
export function ownedFileLogger(formatter: Logger.Logger<unknown, string>, file: string) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const outer = yield* Scope.Scope
      const scope = yield* Scope.make()
      const built = Promise.withResolvers<void>()
      const failures: unknown[] = []
      let fenced = false
      let closing: Promise<void> | undefined
      let native: ReturnType<typeof logRoot> | undefined
      const owner = {
        fence() {
          fenced = true
        },
        close() {
          fenced = true
          closing ??= built.promise
            .then(() => Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.exit)))
            .then((exit) => {
              if (Exit.isFailure(exit)) failures.push(exit.cause)
              else native?.close()
              if (failures.length) throw new AggregateError(failures, "Native Effect logger flush or close failed")
            })
          return closing
        },
      }
      yield* Effect.sync(() => {
        RuntimeRegistry.check()
        if (closed) throw new Error("Effect file logger admission is terminal")
        if (outer.state._tag === "Closed") throw new Error("Effect file logger scope is closed")
        // Check and register in one synchronous turn: a closed scope must not execute
        // our construction-joining finalizer in the constructor's own fiber.
        Effect.runSync(
          Scope.addFinalizer(
            outer,
            Effect.promise(() => owner.close()),
          ),
        )
        owners.add(owner)
      })
      const observed = FileSystem.make({
        ...fs,
        open: (...args) =>
          fs.open(...args).pipe(
            Effect.map((file) => ({
              ...file,
              // The builtin logger ignores write errors. Retain their raw causes before that policy,
              // and join an accepted native write even if its batching fiber is interrupted.
              write: (buffer) =>
                file.write(buffer).pipe(
                  Effect.uninterruptible,
                  Effect.tapCause((cause) => Effect.sync(() => failures.push(cause))),
                ),
            })),
          ),
      })
      const logger = yield* Effect.gen(function* () {
        native = yield* Effect.sync(() => logRoot(path.dirname(file)))
        native.opening()
        return yield* Scope.provide(scope)(
          Logger.toFile(formatter, path.join(native.path, path.basename(file)), { flag: "a" }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, observed))
      }).pipe(
        Effect.tapCause((cause) => Effect.sync(() => failures.push(cause))),
        Effect.ensuring(
          Effect.sync(() => {
            try {
              native?.finish()
            } catch (err) {
              failures.push(err)
              throw err
            } finally {
              built.resolve()
            }
          }),
        ),
      )
      return Logger.make((options) => {
        if (fenced) return
        logger.log(options)
      })
    }),
  )
}
