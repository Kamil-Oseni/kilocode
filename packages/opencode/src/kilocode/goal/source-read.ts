import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SourceRead } from "./criteria"
import { whole } from "./read-artifact"

const normalize = (file: string) =>
  process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)

/** Inspect only this worker's eligible cited Reads; the criterion grants no filesystem access. */
export const verify = (check: SourceRead, cited: readonly SessionV1.ToolPart[], session: string) =>
  Effect.gen(function* () {
    if (!Schema.is(SourceRead)(check)) return false
    for (const part of cited) {
      if (part.sessionID !== session || part.tool !== "read" || part.state.status !== "completed") continue
      const display = part.state.metadata["display"]
      if (
        part.state.metadata["truncated"] === true ||
        (typeof display === "object" && display !== null && "truncated" in display && display.truncated === true)
      )
        continue
      const read = yield* whole(part.state.metadata)
      if (
        !read ||
        read.text === undefined ||
        normalize(read.path) !== normalize(check.path) ||
        normalize(read.canonical) !== normalize(check.canonical) ||
        read.sha256 !== check.sha256 ||
        read.bytes !== check.bytes
      )
        continue
      const bytes = Buffer.from(read.text, "utf8")
      if (
        bytes.toString("utf8") !== read.text ||
        bytes.length !== check.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== check.sha256
      )
        continue
      return true
    }
    return false
  })
