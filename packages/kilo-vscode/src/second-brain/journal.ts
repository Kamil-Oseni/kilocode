import { debt } from "./debt-v2"

type Row = Record<string, unknown>
function row(value: unknown, keys: string[]): Row {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("Memory uncertainty metadata refused")
  return value as Row
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Inert metadata only. A journal can refuse intake; it cannot authorize publication or replay. */
export function journal(input: unknown) {
  if (input && typeof input === "object" && "version" in input && input.version === 2) return debt(input)
  const value = row(input, ["format", "version", "root", "request"])
  if (
    value.format !== "raya.memory.control.uncertainty" ||
    value.version !== 1 ||
    typeof value.root !== "string" ||
    !/^[a-z]:[/\\]/i.test(value.root) ||
    Buffer.byteLength(JSON.stringify(input)) > 16384
  )
    throw new Error("Memory uncertainty identity refused")
  if (value.request && typeof value.request === "object" && "op" in value.request && value.request.op === "sync") {
    sync(value.request, value.root)
    return JSON.parse(JSON.stringify(value)) as Row
  }
  mutation(value.request)
  return JSON.parse(JSON.stringify(value)) as Row
}

function sync(input: unknown, root: unknown) {
  const request = row(input, ["op", "id", "expected", "bodySHA", "root", "source_sha256"])
  if (
    typeof request.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(request.id) ||
    !hash(request.expected) ||
    !hash(request.bodySHA) ||
    request.root !== root
  )
    throw new Error("Memory sync metadata refused")
  const pins = row(request.source_sha256, ["server.py", "index.py", "notes.py", "policy.py", "admission.py"])
  if (Object.values(pins).some((value) => !hash(value))) throw new Error("Memory sync pins refused")
}

function mutation(input: unknown) {
  const request = row(input, ["op", "seq", "bytes", "digest", "identity", "mutation"])
  if (
    !["approve", "policy_pause"].includes(String(request.op)) ||
    !count(request.seq) ||
    !count(request.bytes) ||
    Number(request.bytes) > 65536 ||
    !hash(request.digest)
  )
    throw new Error("Memory uncertainty request refused")
  identity(request.identity)
  const mutation = row(request.mutation, ["expected", "prospective", "revision", "enabled", "namespace"])
  if (
    !(mutation.expected === null || hash(mutation.expected)) ||
    !hash(mutation.prospective) ||
    !count(mutation.revision) ||
    typeof mutation.enabled !== "boolean"
  )
    throw new Error("Memory mutation metadata refused")
  namespace(mutation.namespace)
}

function identity(input: unknown) {
  const identity = row(input, ["pid", "birth", "parent", "executable", "digest"])
  if (
    !count(identity.pid) ||
    !count(identity.parent) ||
    typeof identity.birth !== "string" ||
    !/^[1-9]\d*$/.test(identity.birth) ||
    typeof identity.executable !== "string" ||
    !hash(identity.digest)
  )
    throw new Error("Memory uncertainty owner refused")
}

function namespace(input: unknown) {
  const namespace = row(input, ["root", "system"])
  for (const key of ["root", "system"]) {
    const tuple = namespace[key]
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple.some(
        (part, index) =>
          !(index === 2 && part === null) &&
          !(typeof part === "string" && /^\d{1,20}$/.test(part) && BigInt(part) <= 18446744073709551615n),
      )
    )
      throw new Error("Exact Memory namespace metadata refused")
  }
}
