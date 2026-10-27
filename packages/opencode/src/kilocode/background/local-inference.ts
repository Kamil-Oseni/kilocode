import type { BackgroundJob } from "@opencode-ai/core/background-job"
import { Effect } from "effect"
import { origin } from "../provider/inference-lane"
import type { Observation } from "../provider/local-scheduler"

/** Project a fresh process observation without mutating the registry or trusting saved runtime hints. */
export function enrich(
  job: BackgroundJob.Info,
  current: (origin: { sessionID: string; messageID: string }) => Observation,
): BackgroundJob.Info {
  const metadata = Object.fromEntries(Object.entries(job.metadata ?? {}).filter(([key]) => key !== "localInference"))
  const selected = origin({ sessionID: metadata.sessionId, messageID: metadata.childMessageID })
  const eligible = job.type === "task" && job.status === "running" && metadata.background === true && selected
  return {
    ...job,
    metadata: {
      ...metadata,
      ...(eligible ? { localInference: current(eligible) } : {}),
    },
  }
}

/** Resolve the transport only after the original background registry is initialized. */
export const list = Effect.fn("BackgroundInference.list")(function* (
  items: BackgroundJob.Info[],
): Effect.fn.Return<BackgroundJob.Info[]> {
  const scheduler = yield* Effect.promise(() => import("../provider/local-scheduler"))
  return items.map((item) => enrich(item, scheduler.observe))
})

export const get = Effect.fn("BackgroundInference.get")(function* (
  item: BackgroundJob.Info | undefined,
): Effect.fn.Return<BackgroundJob.Info | undefined> {
  if (!item) return undefined
  const scheduler = yield* Effect.promise(() => import("../provider/local-scheduler"))
  return enrich(item, scheduler.observe)
})
