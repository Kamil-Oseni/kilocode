import z from "zod"

const phases = Object.freeze({
  probe: "RAYA_SOURCE_IMAGE_PROBE_REFUSED",
  frame: "RAYA_SOURCE_IMAGE_FRAME_REFUSED",
  path: "RAYA_SOURCE_IMAGE_PATH_REFUSED",
  bytes: "RAYA_SOURCE_IMAGE_BYTES_REFUSED",
  "current-birth": "RAYA_SOURCE_IMAGE_CURRENT_BIRTH_REFUSED",
})
export type ImagePhase = keyof typeof phases
export const codes = Object.freeze([...Object.values(phases), "RAYA_SOURCE_IMAGE_STAGE_INVALID"])
const accepted = new Map(Object.entries(phases))

/** Fixed substeps only; original diagnostics remain in memory and are never public text. */
export function refused(cause: unknown, phase: unknown) {
  const code = (typeof phase === "string" ? accepted.get(phase) : undefined) ?? "RAYA_SOURCE_IMAGE_STAGE_INVALID"
  return Object.assign(new Error("Native source image verification refused", { cause }), { code })
}

/** The production probe's exact bounded frame, shared with real protocol rejection tests. */
export function decode(text: string) {
  if (text.length > 65536) throw new Error("Native source image frame exceeds its bound")
  return z.tuple([z.string().regex(/^\d{1,20}$/), z.string()]).parse(JSON.parse(text))
}
