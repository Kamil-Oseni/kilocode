import { Effect } from "effect"
import { RepositoryAdmission } from "@opencode-ai/core/kilocode/repository-admission"
import { KiloShutdown } from "../cli/shutdown"
import { ProfileWriterLive } from "../migration/writer-live"

// Import-time fence precedes lazy Reference/RepositoryCache service realization in every hosted graph.
KiloShutdown.register(() => {
  RepositoryAdmission.process.fence()
  return Effect.runPromise(RepositoryAdmission.process.drain)
})
RepositoryAdmission.process.install(() => ProfileWriterLive.repos())
