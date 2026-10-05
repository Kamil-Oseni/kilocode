import path from "node:path"
import { readFile } from "node:fs/promises"
import { Cause, Effect } from "effect"
import { ModelOwner } from "../../../config/model-owner"
import { settle } from "@opencode-ai/tui/kilocode/settlement"

type Data = Record<string, unknown>

function read(state: string): Promise<Data> {
  return readFile(path.join(state, "model.json"), "utf8")
    .then((text): Data => {
      const data: unknown = JSON.parse(text)
      const valid = (value: unknown): value is Data =>
        value !== null && typeof value === "object" && !Array.isArray(value)
      return valid(data) ? data : {}
    })
    .catch((err: unknown): Data => {
      if (err instanceof SyntaxError) return {}
      if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
      throw err
    })
}

/** One actual renderer generation, with the same captured state path as TuiPaths. */
export function make(state: string, owner = ModelOwner.process, load = () => read(state)) {
  const group = owner.group()
  const pending = new Set<Promise<unknown>>()
  const errors: unknown[] = []
  let closed = false
  let retirement: Promise<void> | undefined
  let hydration: Promise<unknown> = Promise.resolve()
  const check = () => {
    if (closed) throw new Error("TUI model writer is retired")
  }
  const hold = <A>(job: Promise<A>) => {
    const done = job.then(
      () => undefined,
      (err: unknown) => {
        if (!errors.includes(err)) errors.push(err)
      },
    )
    pending.add(done)
    void done.then(() => pending.delete(done))
    return job
  }
  return {
    observe(job: Promise<unknown>) {
      check()
      void hold(job)
    },
    read() {
      check()
      const job = hold(Promise.resolve().then(load))
      hydration = job
      return job
    },
    change(body: (data: Data) => Data) {
      check()
      return hold(
        group.launch(state, async (ticket) => {
          await hydration
          return owner.result(Effect.runPromiseExit(owner.effect(ticket, owner.update(body))))
        }),
      )
    },
    settle() {
      if (retirement) return retirement
      closed = true
      const counted = group.settle()
      retirement = (async () => {
        await counted
        while (pending.size) await Promise.all(pending)
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, "TUI model retirement failed")
      })()
      return retirement
    },
  }
}

export function scope<A, E, R>(
  state: string,
  body: (port: ReturnType<typeof make>) => Effect.Effect<A, E, R>,
  owner = ModelOwner.process,
  load?: () => Promise<Data>,
) {
  const causes = <E>(cause: Cause.Cause<E>) => cause.reasons.map((reason) => Cause.squash(Cause.fromReasons([reason])))
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const port = make(state, owner, load)
      const result = yield* Effect.exit(settle(restore(Effect.suspend(() => body(port)))))
      const cleanup = yield* Effect.exit(Effect.promise(() => port.settle()))
      if (result._tag === "Failure" && cleanup._tag === "Failure")
        return yield* Effect.die(
          new AggregateError(
            [...causes(result.cause), ...causes(cleanup.cause)],
            "TUI body and model retirement failed",
          ),
        )
      if (cleanup._tag === "Failure") return yield* Effect.failCause(cleanup.cause)
      if (result._tag === "Failure") {
        if (result.cause.reasons.length > 1)
          return yield* Effect.die(new AggregateError(causes(result.cause), "TUI body and finalizers failed"))
        return yield* Effect.failCause(result.cause)
      }
      return result.value
    }),
  )
}
