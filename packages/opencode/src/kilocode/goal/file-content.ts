import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FileContent } from "./criteria"
import { whole } from "./read-artifact"

const normalize = (file: string) =>
  process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)

/** Check only full text captured by cited authorized Reads of the still-current file. */
export const verify = (check: FileContent, cited: readonly SessionV1.ToolPart[]) =>
  Effect.gen(function* () {
    if (!Schema.is(FileContent)(check)) return false
    for (const part of cited) {
      if (part.tool !== "read" || part.state.status !== "completed") continue
      const display = part.state.metadata["display"]
      if (
        part.state.metadata["truncated"] === true ||
        (typeof display === "object" && display !== null && "truncated" in display && display.truncated === true)
      )
        continue
      const read = yield* whole(part.state.metadata)
      const text = read?.text
      if (
        !read ||
        text === undefined ||
        normalize(read.path) !== normalize(check.path) ||
        normalize(read.canonical) !== normalize(check.path)
      )
        continue
      const bytes = Buffer.from(text, "utf8")
      if (
        bytes.toString("utf8") !== text ||
        bytes.length !== read.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== read.sha256 ||
        !check.literals.every((literal) => text.includes(literal))
      )
        continue
      return true
    }
    return false
  })
