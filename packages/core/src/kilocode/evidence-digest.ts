import { createHash } from "node:crypto"

const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([one], [two]) => (one < two ? -1 : one > two ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    )
  return value
}

/** Fingerprint persisted tool content, independent of JSON object key order. */
export const digest = (part: { tool: string; state: unknown }) =>
  createHash("sha256")
    .update(JSON.stringify(ordered({ tool: part.tool, state: part.state })))
    .digest("hex")
