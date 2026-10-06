import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import type { BackgroundJob } from "@/background/job"
import type { BackgroundJobCancelPayload } from "./groups/kilocode"

export const cancel = (background: Pick<BackgroundJob.Interface, "cancelTree">) =>
  Effect.fn("KilocodeHttpApi.backgroundJobCancel")(function* (ctx: {
    params: { jobID: string }
    payload: typeof BackgroundJobCancelPayload.Type
  }) {
    const status = yield* background.cancelTree(ctx.params.jobID, ctx.payload.revision)
    if (status === "missing") return yield* new HttpApiError.NotFound({})
    if (status === "stale") return yield* new HttpApiError.Conflict({})
    return status === "cancelled"
  })
