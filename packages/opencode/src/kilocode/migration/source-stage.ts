const phases = Object.freeze({
  "source-image": "RAYA_SOURCE_IMAGE_REFUSED",
  "source-binding": "RAYA_SOURCE_BINDING_REFUSED",
  "root-policy": "RAYA_SOURCE_ROOT_POLICY_REFUSED",
  "job-binding": "RAYA_SOURCE_JOB_BINDING_REFUSED",
  "family-ready": "RAYA_SOURCE_FAMILY_READY_REFUSED",
  "watch-ready": "RAYA_SOURCE_WATCH_READY_REFUSED",
  "control-ready": "RAYA_SOURCE_CONTROL_READY_REFUSED",
  "watch-exit": "RAYA_SOURCE_WATCH_EXIT_REFUSED",
  "signed-ack": "RAYA_SOURCE_SIGNED_ACK_REFUSED",
  "observation-roots": "RAYA_SOURCE_OBSERVATION_ROOTS_REFUSED",
  "state-scope": "RAYA_SOURCE_STATE_SCOPE_REFUSED",
  "historical-policy": "RAYA_SOURCE_HISTORICAL_POLICY_REFUSED",
  "family-closure": "RAYA_SOURCE_FAMILY_CLOSURE_REFUSED",
  "retired-policy": "RAYA_SOURCE_RETIRED_POLICY_REFUSED",
  "union-roots": "RAYA_SOURCE_UNION_ROOTS_REFUSED",
  "export-callback": "RAYA_SOURCE_EXPORT_CALLBACK_REFUSED",
  "capture-selection": "RAYA_SOURCE_CAPTURE_SELECTION_REFUSED",
  "capture-namespaces": "RAYA_SOURCE_CAPTURE_NAMESPACES_REFUSED",
  "capture-artifacts": "RAYA_SOURCE_CAPTURE_ARTIFACTS_REFUSED",
  "capture-planning": "RAYA_SOURCE_CAPTURE_PLANNING_REFUSED",
  "capture-metadata": "RAYA_SOURCE_CAPTURE_METADATA_REFUSED",
  "capture-payload": "RAYA_SOURCE_CAPTURE_PAYLOAD_REFUSED",
  "capture-config": "RAYA_SOURCE_CAPTURE_CONFIG_REFUSED",
  "capture-profile": "RAYA_SOURCE_CAPTURE_PROFILE_REFUSED",
  "correspondence-config": "RAYA_SOURCE_CORRESPONDENCE_CONFIG_REFUSED",
  "correspondence-markdown": "RAYA_SOURCE_CORRESPONDENCE_MARKDOWN_REFUSED",
  "correspondence-git": "RAYA_SOURCE_CORRESPONDENCE_GIT_REFUSED",
  "correspondence-host": "RAYA_SOURCE_CORRESPONDENCE_HOST_REFUSED",
  "correspondence-voice": "RAYA_SOURCE_CORRESPONDENCE_VOICE_REFUSED",
  "correspondence-operational": "RAYA_SOURCE_CORRESPONDENCE_OPERATIONAL_REFUSED",
  "correspondence-historical": "RAYA_SOURCE_CORRESPONDENCE_HISTORICAL_REFUSED",
  "correspondence-storage": "RAYA_SOURCE_CORRESPONDENCE_STORAGE_REFUSED",
  "correspondence-composer": "RAYA_SOURCE_CORRESPONDENCE_COMPOSER_REFUSED",
  "correspondence-disposition": "RAYA_SOURCE_CORRESPONDENCE_DISPOSITION_REFUSED",
  "capture-publication": "RAYA_SOURCE_CAPTURE_PUBLICATION_REFUSED",
  "held-admission": "RAYA_SOURCE_HELD_ADMISSION_REFUSED",
  "result-publication": "RAYA_SOURCE_RESULT_PUBLICATION_REFUSED",
})
export type Phase = keyof typeof phases
export const codes = Object.freeze([...Object.values(phases), "RAYA_SOURCE_STAGE_INVALID"])
const accepted = new Map(Object.entries(phases))

/** Only fixed phase codes are public; the original cause remains in memory. */
export function staged(cause: unknown, phase: unknown) {
  const code = (typeof phase === "string" ? accepted.get(phase) : undefined) ?? "RAYA_SOURCE_STAGE_INVALID"
  return Object.assign(new Error("Source preparation refused", { cause }), { code })
}

/** Synchronous held readers retain their call order and original failure cause. */
export function check<T>(phase: Phase, action: () => T): T {
  try {
    return action()
  } catch (cause) {
    throw staged(cause, phase)
  }
}

/** Await the actual reader; diagnostics never turn a refused operation into success. */
export async function checked<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    throw staged(cause, phase)
  }
}
