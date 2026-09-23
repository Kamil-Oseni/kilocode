import { Effect } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"

/** Resolve a planned child from durable authority, never from the task caller's substitutions. */
export namespace ChiefTaskBinding {
  export function load(input: {
    storage?: Storage.Interface
    branches?: ReturnType<typeof ChiefBranches.make>
    sessionID: SessionID
    agent: string
    metadata?: Record<string, unknown>
    callID?: string
    params: {
      branch_id?: string
      task_id?: string
      access?: "read" | "edit"
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
      const record = input.branches ? yield* input.branches.read(input.sessionID) : undefined
      const goal =
        record && input.storage
          ? yield* input.storage
              .read<{
                createdAt?: number
                status?: string
                dispatch?: { messageID?: string }
              }>(["raya", "goal", input.sessionID])
              .pipe(
                Effect.catchIf(
                  (err) => Storage.NotFoundError.isInstance(err),
                  () => Effect.succeed(undefined),
                ),
              )
          : undefined
      const plan = goal?.status === "active" && goal.createdAt === record?.goalCreatedAt ? record : undefined
      if (plan && goal?.dispatch?.messageID !== plan.requestID)
        throw new Error("Auto Chief branch plan does not match the current user request")
      if (input.params.branch_id && !plan) throw new Error("No active Auto Chief branch plan matches this task")
      if (plan && input.agent !== "auto") throw new Error("Only Auto Chief can run its planned branches")
      if (plan && RayaChief.phase(input.metadata) !== "task")
        throw new Error("Auto Chief branches can run only during the task phase")
      if (plan && (!input.params.branch_id || !input.callID))
        throw new Error("A planned Auto Chief task needs its exact branch ID and call ID")
      const branch = plan?.branches.find((item) => item.id === input.params.branch_id)
      if (plan && !branch) throw new Error("Unknown Auto Chief branch")
      if (branch && branch.state !== "planned")
        throw new Error("Auto Chief branch has already been admitted")
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
      return { plan, branch }
    })
  }
}
