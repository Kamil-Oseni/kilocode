import { Cause, Effect, Exit } from "effect"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { SessionID } from "@/session/schema"

/** A child run may settle only its exact admitted branch; uncertain effects never become success. */
export namespace ChiefBranchOutcome {
  export function record(input: {
    branches: ReturnType<typeof ChiefBranches.make>
    goalID: SessionID
    goalCreatedAt: number
    branchID: string
    callID: string
    sessionID: SessionID
    exit: Exit.Exit<string, unknown>
  }) {
    const state = Exit.isSuccess(input.exit)
      ? "completed"
      : input.exit.cause.reasons.some(Cause.isDieReason)
        ? "unknown"
        : Cause.hasInterrupts(input.exit.cause)
          ? "cancelled"
          : "failed"
    const result = {
      completed: "Child task completed; inspect its saved result before review.",
      cancelled: "Child task was interrupted.",
      unknown: "Child task outcome is unknown; do not replay automatically.",
      failed: "Child task failed.",
    }[state]
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
}
