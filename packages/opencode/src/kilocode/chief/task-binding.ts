import { Effect } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { Storage } from "@/storage/storage"

/** Resolve a planned child from durable authority, never from the task caller's substitutions. */
export namespace ChiefTaskBinding {
  export function load(input: {
    storage?: Storage.Interface
    sessions?: Pick<Session.Interface, "get" | "messages">
    branches?: ReturnType<typeof ChiefBranches.make>
    sessionID: SessionID
    agent: string
    metadata?: Record<string, unknown>
    callID?: string
    params: {
      branch_id?: string
      task_id?: string
      access?: "read" | "edit" | "computer"
      subagent_type?: string
      prompt?: string
      brief?: {
        objective: string
        context?: string
        expected_return?: string
        constraints?: readonly string[]
      }
    }
  }) {
    return Effect.gen(function* () {
      const marker = input.storage ? yield* ChiefRequestPlan.active(input.storage, input.sessionID) : undefined
      if (marker && !input.sessions) throw new Error("Chief request plan requires saved request verification")
      const rows = marker && input.sessions ? yield* input.sessions.messages({ sessionID: input.sessionID }) : []
      const latest = rows.filter((row) => row.info.role === "user" && RayaChief.requestText(row.parts)).at(-1)
      const stale = marker && latest && marker.identity.requestID !== latest.info.id
      if (stale && !input.params.branch_id && input.agent === "auto" && RayaChief.phase(input.metadata) === "task")
        yield* ChiefRequestPlan.make(input.storage!, input.sessions!).rotate({
          sessionID: input.sessionID,
          priorRequestID: marker.identity.requestID,
          nextRequestID: latest.info.id,
        })
      const request =
        marker && !stale
          ? yield* ChiefRequestPlan.make(input.storage!, input.sessions!).load(input.sessionID)
          : undefined
      if (stale && (yield* ChiefRequestPlan.active(input.storage!, input.sessionID)))
        throw new Error("A prior Chief request plan has not been safely retired")
      const record = input.branches ? yield* input.branches.read(input.sessionID) : undefined
      const goal =
        record && input.storage
          ? yield* input.storage
              .read<{
                createdAt?: number
                status?: string
                revisions?: { id?: string }[]
              }>(["raya", "goal", input.sessionID])
              .pipe(
                Effect.catchIf(
                  (err) => Storage.NotFoundError.isInstance(err),
                  () => Effect.succeed(undefined),
                ),
              )
          : undefined
      const plan = record && ChiefBranches.matches(record, goal) ? record : undefined
      if (plan && request) throw new Error("Conflicting goal and request Chief plans")
      if (input.params.branch_id && !plan && !request)
        throw new Error("No active Auto Chief branch plan matches this task")
      if ((plan || request) && input.agent !== "auto") throw new Error("Only Auto Chief can run its planned branches")
      if ((plan || request) && RayaChief.phase(input.metadata) !== "task")
        throw new Error("Auto Chief branches can run only during the task phase")
      if ((plan || request) && (!input.params.branch_id || !input.callID))
        throw new Error("A planned Auto Chief task needs its exact branch ID and call ID")
      const branch = (request ?? plan)?.branches.find((item) => item.id === input.params.branch_id)
      if ((plan || request) && !branch) throw new Error("Unknown Auto Chief branch")
      if (branch && branch.state !== "planned") throw new Error("Auto Chief branch has already been admitted")
      if (branch && (input.params.task_id || (input.params.access && input.params.access !== branch.access)))
        throw new Error("Auto Chief branch identity or authority cannot be changed")
      if (
        branch &&
        input.params.subagent_type &&
        input.params.subagent_type !== "auto" &&
        input.params.subagent_type !== branch.specialist
      )
        throw new Error("Auto Chief branch specialist cannot be changed")
      if (branch && input.params.prompt && input.params.prompt !== branch.brief.objective)
        throw new Error("Auto Chief branch objective cannot be changed")
      if (
        branch &&
        input.params.brief &&
        (input.params.brief.objective !== branch.brief.objective ||
          (input.params.brief.context !== undefined && input.params.brief.context !== branch.brief.context) ||
          (input.params.brief.expected_return !== undefined &&
            input.params.brief.expected_return !== branch.brief.expectedReturn) ||
          (input.params.brief.constraints !== undefined &&
            JSON.stringify(input.params.brief.constraints) !== JSON.stringify(branch.brief.constraints)))
      )
        throw new Error("Auto Chief branch brief cannot be changed")
      return { plan, request, branch }
    })
  }
}
