import { sources } from "./setup-v2"

function row(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== keys.sort().join()
  )
    throw new Error("Memory operation debt fields refused")
  return input as Record<string, unknown>
}
const hex = (input: unknown, length: number) =>
  typeof input === "string" && input.length === length && new RegExp(`^[a-f0-9]{${length}}$`).test(input)

function absolute(input: unknown) {
  return typeof input === "string" && /^[a-z]:[/\\]/i.test(input) && !/[\x00-\x1f]/.test(input) && input.length <= 4096
}

/** Inert correlation metadata. A debt entry never permits replay or adopts restarted workers. */
export function debt(input: unknown) {
  const value = row(input, ["format", "version", "protocol", "root", "request"])
  if (
    value.format !== "raya.memory.control.uncertainty" ||
    value.version !== 2 ||
    !["raya.memory.operation.v1", "raya.memory.operation.v2"].some((protocol) => value.protocol === protocol) ||
    !absolute(value.root) ||
    Buffer.byteLength(JSON.stringify(input)) > 16384
  )
    throw new Error("Memory operation debt identity refused")
  const request = row(value.request, [
    "op",
    "id",
    "root",
    "owner_epoch",
    "selected_release_sha256",
    "bodySHA",
    "source_sha256",
    ...(value.request && typeof value.request === "object" && "op" in value.request && value.request.op === "sync"
      ? ["expected"]
      : []),
  ])
  if (
    typeof request.op !== "string" ||
    !["sync", "search"].includes(request.op) ||
    !hex(request.id, 32) ||
    !hex(request.owner_epoch, 32) ||
    !hex(request.selected_release_sha256, 64) ||
    !hex(request.bodySHA, 64) ||
    request.root !== value.root ||
    (request.op === "sync" && !hex(request.expected, 64))
  )
    throw new Error("Memory operation debt request refused")
  const pins = row(request.source_sha256, [...sources])
  if (Object.values(pins).some((value) => !hex(value, 64))) throw new Error("Memory operation debt pins refused")
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}
