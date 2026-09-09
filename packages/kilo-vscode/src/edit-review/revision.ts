import { createHash } from "node:crypto"
import type { ReviewFileDiff } from "@kilocode/sdk/v2"

/** Versioned review identity; keep these tuples in sync with the backend contract. */
export function fingerprint(diff: ReviewFileDiff) {
  const content = [diff.file, diff.patch, diff.before, diff.after, diff.status]
  return createHash("sha256")
    .update(JSON.stringify(diff.generation === undefined ? content : ["v2", ...content, diff.generation]))
    .digest("hex")
}
