import { Cause, Effect, Exit } from "effect"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { MessageID, SessionID } from "@/session/schema"

/** A child run may settle only its exact admitted branch; uncertain effects never become success. */
export namespace ChiefBranchOutcome {
  function outcome(exit: Exit.Exit<string, unknown>) {
    const state: "completed" | "failed" | "cancelled" | "unknown" = Exit.isSuccess(exit)
      ? "completed"
      : exit.cause.reasons.some(Cause.isDieReason)
        ? "unknown"
        : Cause.hasInterrupts(exit.cause)
          ? "cancelled"
          : "failed"
    const result = {
      completed: "Child task completed; inspect its saved result before review.",
      cancelled: "Child task was interrupted.",
      unknown: "Child task outcome is unknown; do not replay automatically.",
      failed: "Child task failed.",
    }[state]
    return { state, result }
  }

  export function record(input: {
    branches: ReturnType<typeof ChiefBranches.make>
    goalID: SessionID
    goalCreatedAt: number
    branchID: string
    callID: string
    sessionID: SessionID
    exit: Exit.Exit<string, unknown>
  }) {
    const { state, result } = outcome(input.exit)
    return input.branches.settle({
      goalID: input.goalID,
      goalCreatedAt: input.goalCreatedAt,
      branchID: input.branchID,
      callID: input.callID,
      sessionID: input.sessionID,
      state,
      result,
    })
  }

  export function request(input: {
    ledger: ReturnType<typeof ChiefRequestPlan.make>
    sessionID: SessionID
    requestID: MessageID
    revision: string
    branchID: string
    callID: string
    childID: SessionID
    messageID: MessageID
    exit: Exit.Exit<string, unknown>
  }) {
    return input.ledger.settle({
      sessionID: input.sessionID,
      requestID: input.requestID,
      revision: input.revision,
      branchID: input.branchID,
      callID: input.callID,
      childID: input.childID,
      messageID: input.messageID,
      ...outcome(input.exit),
    })
  }
}
