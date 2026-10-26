import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { record } from "./continuation"
import { RayaTaskSnapshot } from "./snapshot"
import { RayaTask } from "."

/** Resolve explicit worker selection from its immutable startup, never a role default or mutable picker. */
export const selection = Effect.fn("RayaTaskModel.selection")(function* (
  storage: Storage.Interface,
  session: {
    id: string
    metadata?: Record<string, unknown>
    model?: { providerID: string; id: string; variant?: string }
  },
) {
  const raw = session.metadata?.rayaRoutine
  if (raw === undefined) return undefined
  const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(
    Effect.mapError(() => new RayaTask.GuardError({ message: "Routine model identity is invalid." })),
  )
  const snapshot = yield* RayaTaskSnapshot.make({ storage }).find(identity.runID)
  if (
    !snapshot ||
    snapshot.sessionID !== session.id ||
    snapshot.agentID !== identity.agentID ||
    (snapshot.definition.scheduleVersion ?? 1) !== identity.scheduleVersion
  )
    return yield* new RayaTask.GuardError({ message: "Routine model startup identity does not match this session." })
  const model = snapshot.definition.model
  if (snapshot.definition.mode || !model) return undefined
  const same = session.model?.providerID === model.providerID && session.model?.id === model.id
  return {
    providerID: ProviderV2.ID.make(model.providerID),
    modelID: ModelV2.ID.make(model.id),
    ...(same && session.model?.variant && session.model.variant !== "default"
      ? { variant: session.model.variant }
      : {}),
  }
})
