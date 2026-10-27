import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Schema } from "effect"
import type { Session } from "@/session/session"
import type { RayaTask } from "."
import type { Item } from "./inbox"
import { Snapshot } from "../provider/inference-observation"

/** Live resource observations never become saved Routine state or execution authority. */
export const project = Effect.fn("RoutineInference.project")(function* <E>(input: {
  items: readonly Item[]
  agents: readonly RayaTask.Agent[]
  runs: ReadonlyMap<string, RayaTask.Run | undefined>
  sessions: Pick<Session.Interface, "get">
  authorized: (run: RayaTask.Run) => Effect.Effect<boolean | undefined, E>
  current: (sessionID: string) => Snapshot
}) {
  const module = yield* Effect.promise(() => import("./continuation"))
  return yield* Effect.forEach(
    input.items,
    (item) =>
      Effect.gen(function* () {
        const clean = { ...item }
        delete clean.inference
        const run = input.runs.get(item.agentID)
        const agent = input.agents.find((row) => row.id === item.agentID)
        if (!agent || !run || !eligible(clean, agent, run)) return clean
        const session = yield* input.sessions.get(run.sessionID).pipe(Effect.option)
        if (Option.isNone(session) || session.value.id !== run.sessionID) return clean
        const identity = Schema.decodeUnknownOption(module.record)(session.value.metadata?.rayaRoutine)
        if (
          Option.isNone(identity) ||
          identity.value.agentID !== run.agentID ||
          identity.value.runID !== run.id ||
          identity.value.scheduleVersion !== (run.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(identity.value.trigger, run.trigger)
        )
          return clean
        if ((yield* input.authorized(run).pipe(Effect.orElseSucceed(() => false))) !== true) return clean
        const snapshot = Schema.decodeUnknownOption(Snapshot)(input.current(run.sessionID))
        if (Option.isNone(snapshot) || snapshot.value.sessionID !== run.sessionID) return clean
        return { ...clean, inference: { runID: run.id, snapshot: snapshot.value } }
      }),
    { concurrency: 4 },
  )
})

function eligible(item: Item, agent: RayaTask.Agent, run: RayaTask.Run) {
  return (
    item.state === "running" &&
    run.status === "running" &&
    run.agentID === agent.id &&
    agent.execution?.state !== "recovery" &&
    (!agent.execution?.runID || agent.execution.runID === run.id) &&
    (!agent.execution?.sessionID || agent.execution.sessionID === run.sessionID)
  )
}
