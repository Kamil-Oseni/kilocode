import { Effect } from "effect"
import * as Invocation from "@opencode-ai/core/kilocode/background-invocation"
import * as TaskWorker from "@/kilocode/session/task-worker"
import type { SessionID } from "@/session/schema"

export const check = (session: SessionID) =>
  Effect.gen(function* () {
    const owner = yield* Effect.serviceOption(Invocation.Owner)
    if (owner._tag === "None") return
    const workers = yield* Effect.serviceOption(TaskWorker.Service)
    const input = workers._tag === "Some" ? yield* workers.value.current : undefined
    yield* Invocation.validate(input?.sessionID === session ? input : undefined)
  })
