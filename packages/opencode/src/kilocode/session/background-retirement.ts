import { Effect } from "effect"
import type { BackgroundJob } from "@/background/job"

export const retire = (background: Pick<BackgroundJob.Interface, "cancel">, job: BackgroundJob.Info) => {
  if (!job.revision) return Effect.die(new Error("Background disposal requires the observed execution revision"))
  return background.cancel(job.id, job.revision)
}
