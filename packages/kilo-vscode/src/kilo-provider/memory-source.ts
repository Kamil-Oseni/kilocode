import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { contains } from "../path-utils"
import { context } from "../second-brain/linked-results"
import type { MemorySourceRequest } from "../shared/memory-source"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function reference(value: unknown): value is MemorySourceRequest {
  if (!record(value) || value.type !== "openMemorySource") return false
  if (
    Object.keys(value).sort().join() !== ["type", "sessionID", "messageID", "partID", "callID", "source"].sort().join()
  )
    return false
  return (
    [value.sessionID, value.messageID, value.partID, value.callID].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id),
    ) &&
    typeof value.source === "number" &&
    Number.isSafeInteger(value.source) &&
    value.source >= 0 &&
    value.source < 12
  )
}

function original(value: unknown, ref: MemorySourceRequest) {
  if (
    !reference(ref) ||
    !record(value) ||
    !record(value.info) ||
    !Array.isArray(value.parts) ||
    value.info.id !== ref.messageID ||
    value.info.sessionID !== ref.sessionID ||
    value.info.role !== "assistant"
  )
    throw new Error("The original Memory source message is unavailable.")
  const rows = value.parts.filter((row: unknown) => record(row) && row.id === ref.partID)
  if (rows.length !== 1) throw new Error("The original completed Memory recall is unavailable.")
  return rows[0] as unknown
}

function completed(part: unknown, ref: MemorySourceRequest) {
  if (
    !record(part) ||
    part.type !== "tool" ||
    part.tool !== "second_brain_recall" ||
    part.sessionID !== ref.sessionID ||
    part.messageID !== ref.messageID ||
    part.callID !== ref.callID ||
    !record(part.state) ||
    part.state.status !== "completed" ||
    typeof part.state.output !== "string" ||
    part.state.output.length > 200_000
  )
    throw new Error("The original completed Memory recall is unavailable.")
  return part.state.output
}

function selected(result: unknown, root: string, directory: string, index: number) {
  if (
    !record(result) ||
    result.action !== "context" ||
    typeof result.root !== "string" ||
    typeof result.project !== "string" ||
    path.resolve(result.root) !== path.resolve(root) ||
    path.resolve(result.project) !== path.resolve(directory)
  )
    throw new Error("This citation belongs to a different Memory selection.")
  const source = context(result.context, root, 12000).sources[index]
  if (!source || !contains(root, source.path)) throw new Error("The selected Memory source is unavailable.")
  return source
}

/** A citation carries identities, never a webview-selected filename or line. */
export async function source(input: {
  message: unknown
  ref: MemorySourceRequest
  root: string
  directory: string
  current: () => boolean
}) {
  const check = () => {
    if (!input.current())
      throw new Error("Memory citation belongs to an unavailable conversation. Open it again from that conversation.")
  }
  check()
  const raw: unknown = JSON.parse(completed(original(input.message, input.ref), input.ref))
  const row = selected(raw, input.root, input.directory, input.ref.source)
  const root = await realpath(input.root)
  const file = await realpath(row.path)
  check()
  if (!contains(root, file)) throw new Error("Memory citation leaves the selected notes folder.")
  const size = await stat(file)
  if (!size.isFile()) throw new Error("Memory citation is not a saved note.")
  if (size.size > 2 * 1024 * 1024) throw new Error("Memory source exceeds the supported note size.")
  const bytes = await readFile(file)
  check()
  if (createHash("sha256").update(bytes).digest("hex") !== row.source_sha256)
    throw new Error("This note changed after recall. Ask Raya to retrieve its current version.")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (row.end_line > text.split(/\r?\n/).length) throw new Error("The cited line is outside the saved note.")
  return { file, line: row.line, text }
}
