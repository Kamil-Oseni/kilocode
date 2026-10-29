import path from "node:path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Artifact from "@/kilocode/goal/artifact"

const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))

/** A bounded explicit owner instruction, not a general natural-language task classifier. */
function requested(request: string) {
  const text = request.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "")
  const clauses = [...text.matchAll(/(?:^|(?<=[.!?]\s))\s*read\s+(?:(["'`])([^\r\n]+?)\1|([^\s]+))/gim)]
  const files = clauses
    .map((match) => match[2] ?? match[3].replace(/[.,;!?]+$/, ""))
    .filter((file) => /^(?:["'`])?(?:[a-z]:[\\/]|\/)/i.test(file))
  if (
    files.length > 16 ||
    files.some((file) => !path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === "." || part === ".."))
  )
    throw new Error("Owner Read instruction requires an unambiguous absolute local file path")
  const unique = [...new Set(files.map(key))]
  // Multi-file requests can have distinct parallel children; this rule cannot assign their scopes.
  return unique.length === 1 ? unique : []
}

/** Only successful reads from this exact child invocation can support its final narrative. */
export function missing(request: string, rows: readonly SessionV1.WithParts[], input: string, completed: number) {
  const files = requested(request)
  return files.filter(
    (file) =>
      !rows.some(
        (row) =>
          row.info.role === "assistant" &&
          row.info.parentID === input &&
          !row.info.error &&
          row.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "read" &&
              part.sessionID === row.info.sessionID &&
              part.messageID === row.info.id &&
              part.state.status === "completed" &&
              part.state.time.start >= row.info.time.created &&
              part.state.time.end >= part.state.time.start &&
              part.state.time.end <= completed &&
              typeof part.state.input.filePath === "string" &&
              key(part.state.input.filePath) === file &&
              Artifact.entries(part.state.metadata.rayaRevision).some(
                (entry) => entry.status === "captured" && key(entry.path) === file && path.isAbsolute(entry.canonical),
              ),
          ),
      ),
  )
}
