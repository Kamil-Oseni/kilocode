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
