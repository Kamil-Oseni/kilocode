import type { Runner } from "@/effect/runner"
import { Context, Effect } from "effect"

/** Bound by the runner to executing work, never inferred from the latest session state. */
export class Execution extends Context.Service<Execution, { id: string }>()("raya/Execution") {}

const identities = new WeakMap<object, string>()

function identity(handle: object) {
  const prior = identities.get(handle)
  if (prior) return prior
  const id = crypto.randomUUID()
  identities.set(handle, id)
  return id
}

export const executing = <A, E, R>(handle: object, work: Effect.Effect<A, E, R>) =>
  work.pipe(Effect.provideService(Execution, { id: identity(handle) }))

/** Process-local execution identities, derived from the runner's actual handles. */
export function observe<A, E>(runner?: Pick<Runner.Runner<A, E>, "state">) {
  const state = runner?.state
  if (!state || state._tag === "Idle") return { phase: "idle" as const }
  if (state._tag === "Running") return { phase: "running" as const, id: identity(state.run.done) }
  if (state._tag === "Shell") return { phase: "shell" as const, id: identity(state.shell.cancelled) }
  return { phase: "shell" as const, id: identity(state.shell.cancelled), queued: identity(state.run.done) }
}
