import { Deferred, Effect, Schema, Semaphore } from "effect"

export namespace ProfileWriterRegistry {
  export const Code = Schema.Literals([
    "unknown-writer",
    "duplicate-writer",
    "unregistered-writer",
    "admission-closed",
    "registry-incomplete",
    "quiescence-active",
  ])
  export type Code = typeof Code.Type

  export class RegistryError extends Schema.TaggedErrorClass<RegistryError>()("ProfileWriterRegistryError", {
    code: Code,
    message: Schema.String,
    id: Schema.optional(Schema.String),
    missing: Schema.optional(Schema.Array(Schema.String)),
  }) {}

  export type Phase = "open" | "draining" | "closed"

  export type Snapshot = {
    phase: Phase
    declared: readonly string[]
    registered: readonly string[]
    active: readonly { id: string; count: number }[]
  }

  export type Registry = {
    register(id: string): Effect.Effect<void, RegistryError>
    run<A, E, R>(id: string, body: Effect.Effect<A, E, R>): Effect.Effect<A, E | RegistryError, R>
    quiesce<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | RegistryError, R>
    readonly snapshot: Effect.Effect<Snapshot>
  }

  export type Manifest = {
    complete: boolean
    gaps: readonly string[]
    writers: readonly {
      id: string
      coverage: "integrated" | "declared-unintegrated" | "uncertain"
    }[]
  }

  export function fromManifest(manifest: Manifest): Registry {
    const pending = manifest.writers.filter((writer) => writer.coverage !== "integrated").map((writer) => writer.id)
    if (!manifest.complete || manifest.gaps.length || pending.length)
      throw new Error("Profile writer manifest is not complete and integrated.")
    return make(manifest.writers.map((writer) => writer.id))
  }

  export function make(input: readonly string[]): Registry {
    const ids = input.map((id) => id.trim()).toSorted()
    if (!ids.length) throw new Error("Profile writer manifest is empty.")
    if (ids.some((id) => !id)) throw new Error("Profile writer manifest contains an empty ID.")
    if (new Set(ids).size !== ids.length) throw new Error("Profile writer manifest contains duplicate IDs.")

    const declared = new Set(ids)
    const registered = new Set<string>()
    const active = new Map<string, number>()
    const gate = Semaphore.makeUnsafe(1)
    let phase: Phase = "open"
    let drain: Deferred.Deferred<void> | undefined

    const locked = <A, E, R>(body: Effect.Effect<A, E, R>) => gate.withPermits(1)(body)
    const fail = (code: Code, message: string, extra?: { id?: string; missing?: string[] }) =>
      Effect.fail(new RegistryError({ code, message, ...extra }))

    const register = (id: string) =>
      locked(
        Effect.gen(function* () {
          if (!declared.has(id)) return yield* fail("unknown-writer", `Profile writer is not declared: ${id}`, { id })
          if (phase !== "open")
            return yield* fail("quiescence-active", `Profile writer registration is closed while ${phase}.`, { id })
          if (registered.has(id))
            return yield* fail("duplicate-writer", `Profile writer is already registered: ${id}`, { id })
          registered.add(id)
        }),
      )

    const acquire = (id: string) =>
      locked(
        Effect.gen(function* () {
          if (!declared.has(id)) return yield* fail("unknown-writer", `Profile writer is not declared: ${id}`, { id })
          if (!registered.has(id))
            return yield* fail("unregistered-writer", `Profile writer is not registered: ${id}`, { id })
          if (phase !== "open")
            return yield* fail("admission-closed", `Profile writer admission is closed while ${phase}: ${id}`, {
              id,
            })
          active.set(id, (active.get(id) ?? 0) + 1)
        }),
      )

    const release = (id: string) =>
      locked(
        Effect.gen(function* () {
          const count = (active.get(id) ?? 1) - 1
          if (count > 0) active.set(id, count)
          if (count === 0) active.delete(id)
          if (phase !== "draining" || active.size !== 0 || !drain) return
          phase = "closed"
          const ready = drain
          drain = undefined
          yield* Deferred.succeed(ready, undefined)
        }),
      )

    const run: Registry["run"] = (id, body) =>
      Effect.acquireUseRelease(
        acquire(id),
        () => body,
        () => release(id),
      )

    const quiesce: Registry["quiesce"] = (body) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>()
          return yield* locked(
            Effect.gen(function* () {
              if (phase !== "open")
                return yield* fail("quiescence-active", `Profile writer quiescence is already ${phase}.`)
              const missing = ids.filter((id) => !registered.has(id))
              if (missing.length)
                return yield* fail("registry-incomplete", "Profile writer registry is incomplete.", { missing })
              phase = active.size === 0 ? "closed" : "draining"
              drain = active.size === 0 ? undefined : ready
              return drain
            }),
          )
        }),
        (ready) => (ready ? Deferred.await(ready).pipe(Effect.andThen(body)) : body),
        () =>
          locked(
            Effect.sync(() => {
              phase = "open"
              drain = undefined
            }),
          ),
      )

    const snapshot = locked(
      Effect.sync(
        (): Snapshot => ({
          phase,
          declared: [...ids],
          registered: [...registered].toSorted(),
          active: [...active].map(([id, count]) => ({ id, count })).toSorted((a, b) => a.id.localeCompare(b.id)),
        }),
      ),
    )

    return { register, run, quiesce, snapshot }
  }
}
