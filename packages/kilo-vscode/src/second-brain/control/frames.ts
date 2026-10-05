import { createHash } from "node:crypto"
import { parseTree, type Node, type ParseError } from "jsonc-parser"

export type Op = "state" | "preview" | "discard" | "approve" | "policy_pause"
export type Generation = Readonly<{ root: readonly (string | null)[]; system: readonly (string | null)[] }>
const generations = new WeakMap<object, Generation>()
export const exact = (value: object) => generations.get(value)
type Value = null | boolean | number | string | Value[] | { [key: string]: Value }
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
export function object(value: Value): { [key: string]: Value } {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Object required")
  return value
}
function fields(value: Value, names: string[]) {
  const row = object(value)
  check(Object.keys(row).sort().join("|") === names.sort().join("|"), "Exact fields required")
  return row
}
function hash(value: Value, nullable = false) {
  check((nullable && value === null) || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)), "Digest required")
}
function integer(value: Value, min = 0, max = 2147483647) {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
    "Bounded integer required",
  )
}
function name(value: Value) {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => !part || part === "." || part === "..") &&
      /\.md$/i.test(value),
    "Relative Markdown name required",
  )
}
function policy(value: Value, root: string) {
  const row = fields(value, ["format", "root", "enabled", "revision", "files"])
  check(
    row.format === "raya-general-sources-v1" && row.root === root && typeof row.enabled === "boolean",
    "Policy identity refused",
  )
  integer(row.revision)
  check(Array.isArray(row.files) && row.files.length <= 128, "Bounded policy files required")
  const names = new Set<string>()
  for (const value of row.files) {
    const file = fields(value, ["relative", "sha256", "classification", "review"])
    name(file.relative)
    hash(file.sha256)
    check(
      file.classification === "general" && ["approved", "proposed"].includes(String(file.review)),
      "Policy class refused",
    )
    check(!names.has(String(file.relative).toLowerCase()), "Duplicate policy source")
    names.add(String(file.relative).toLowerCase())
  }
  return row
}
export function decode(raw: Uint8Array, limit = 2097152) {
  check(raw.length <= limit && raw.length > 0 && raw[raw.length - 1] === 10, "Bounded complete frame required")
  return document(raw, limit)
}
/** Strict JSON documents have independent bounds and need no wire-frame newline. */
export function document(raw: Uint8Array, limit = 2097152, nodes = 20000) {
  check(raw.length <= limit && raw.length > 0, "Bounded JSON document required")
  check(!(raw[0] === 239 && raw[1] === 187 && raw[2] === 191), "JSON BOM refused")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  check(tree && errors.length === 0, "Strict JSON required")
  let count = 0
  function bounds(node: Node, depth: number) {
    check(++count <= nodes && depth <= 32, "JSON structure bound exceeded")
    for (const next of node.children ?? []) bounds(next, depth + 1)
  }
  bounds(tree, 0)
  function read(node: Node): Value {
    if (node.type === "object") {
      const result: { [key: string]: Value } = Object.create(null)
      for (const item of node.children ?? []) {
        const children = item.children!
        const key = children[0].value as string
        check(!Object.hasOwn(result, key), "Duplicate JSON field")
        result[key] = read(children[1])
      }
      return result
    }
    if (node.type === "array") return (node.children ?? []).map((child) => read(child))
    if (node.type === "number") check(Number.isFinite(node.value), "Finite JSON number required")
    check(["string", "number", "boolean", "null"].includes(node.type), "JSON value required")
    return node.value as Value
  }
  const value = read(tree)
  object(value)
  return { value, tree, text }
}
export function child(node: Node, key: string) {
  check(node.type === "object", "JSON object node required")
  const found = node.children?.find((item) => item.children?.[0].value === key)?.children?.[1]
  check(found, "JSON field node required")
  return found
}
// Preserve original integer tokens: Python namespace nanoseconds exceed JS safe integers.
export function canonical(node: Node, text: string, ascii = false): string {
  const string = (value: string) => {
    const raw = JSON.stringify(value)
    return ascii
      ? raw.replace(/[\u0080-\uffff]/g, (item) => "\\u" + item.charCodeAt(0).toString(16).padStart(4, "0"))
      : raw
  }
  if (node.type === "object")
    return (
      "{" +
      [...(node.children ?? [])]
        .sort((a, b) => (String(a.children![0].value) < String(b.children![0].value) ? -1 : 1))
        .map((item) => string(item.children![0].value) + ":" + canonical(item.children![1], text, ascii))
        .join(",") +
      "}"
    )
  if (node.type === "array")
    return "[" + (node.children ?? []).map((item) => canonical(item, text, ascii)).join(",") + "]"
  if (node.type === "string") return string(node.value)
  return text.slice(node.offset, node.offset + node.length)
}
export function reply(raw: Uint8Array, op: Op, seq: number, root: string) {
  const decoded = decode(raw)
  const row = object(decoded.value)
  fields(
    row,
    row.ok === true ? ["format", "version", "seq", "ok", "result"] : ["format", "version", "seq", "ok", "error"],
  )
  check(
    row.format === "raya.memory.control.reply" && row.version === 1 && row.seq === seq && typeof row.ok === "boolean",
    "Reply identity refused",
  )
  if (!row.ok) {
    const err = fields(row.error, ["kind", "message", "types", "publication"])
    check(
      err.kind === "control_refused" &&
        err.message === "Control operation refused; inspect current identity and review." &&
        err.publication === (["approve", "policy_pause"].includes(op) ? "may_have_happened" : "none"),
      "Refusal identity refused",
    )
    check(
      Array.isArray(err.types) &&
        err.types.length > 0 &&
        err.types.length <= 32 &&
        err.types.every((item) => typeof item === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item)),
      "Bounded refusal classes required",
    )
    throw new Error("Control refused: " + err.types.join(",") + "; publication=" + err.publication)
  }
  const value = object(row.result)
  if (op === "state") {
    fields(value, ["policy_sha256", "policy", "capture_enabled"])
    hash(value.policy_sha256, true)
    policy(value.policy, root)
    check(value.capture_enabled === false, "Capture flag refused")
  }
  if (op === "discard") {
    fields(value, ["discarded"])
    check(typeof value.discarded === "boolean", "Discard result refused")
  }
  if (op === "approve" || op === "policy_pause") publication(value, op)
  if (op === "preview") preview(value, decoded, root)
  return value
}

function preview(value: { [key: string]: Value }, decoded: ReturnType<typeof decode>, root: string) {
  fields(value, ["preview", "preview_sha256", "expires_seconds"])
  hash(value.preview_sha256)
  check(value.expires_seconds === 900, "Preview expiry refused")
  const plan = fields(value.preview, [
    "format",
    "id",
    "expected_policy_sha256",
    "prior",
    "sources",
    "policy",
    "namespace",
    "prospective_policy_sha256",
    "ignore_sha256",
    "effect",
  ])
  check(
    plan.format === "raya-general-review-v1" && typeof plan.id === "string" && /^[a-f0-9-]{36}$/.test(plan.id),
    "Preview identity refused",
  )
  hash(plan.expected_policy_sha256, true)
  hash(plan.prospective_policy_sha256)
  hash(plan.ignore_sha256, true)
  const prior = policy(plan.prior, root)
  const next = policy(plan.policy, root)
  check(next.revision === Number(prior.revision) + 1, "Policy revision refused")
  check(
    plan.effect === "Replace the complete source allowlist; omitted sources are removed. No sync or model request.",
    "Preview effect refused",
  )
  const ns = fields(plan.namespace, ["format", "root", "generation"])
  check(ns.format === "raya-memory-namespace-v1" && ns.root === root, "Namespace identity refused")
  const generation = fields(ns.generation, ["root", "system"])
  const node = child(child(child(child(decoded.tree, "result"), "preview"), "namespace"), "generation")
  const original = {} as { root: readonly (string | null)[]; system: readonly (string | null)[] }
  for (const key of ["root", "system"]) {
    const tuple = generation[key]
    check(Array.isArray(tuple) && tuple.length === 3, "Directory tuple required")
    const tokens = child(node, key).children!
    tokens.forEach((token, index) => {
      const text = decoded.text.slice(token.offset, token.offset + token.length)
      check(
        (index === 2 && text === "null") || (/^\d{1,20}$/.test(text) && BigInt(text) <= 18446744073709551615n),
        "Directory integer refused",
      )
    })
    original[key as "root" | "system"] = Object.freeze(
      tokens.map((token) =>
        token.type === "null" ? null : decoded.text.slice(token.offset, token.offset + token.length),
      ),
    )
  }
  check(
    Array.isArray(plan.sources) && plan.sources.length >= 1 && plan.sources.length <= 128,
    "Preview sources required",
  )
  let bytes = 0
  for (const source of plan.sources) {
    const file = fields(source, ["relative", "sha256", "bytes", "text", "classification", "review"])
    name(file.relative)
    hash(file.sha256)
    integer(file.bytes, 0, 65536)
    check(
      typeof file.text === "string" &&
        Buffer.byteLength(file.text) === file.bytes &&
        sha(file.text) === file.sha256 &&
        file.classification === "general" &&
        file.review === "proposed",
      "Source bytes refused",
    )
    bytes += Number(file.bytes)
  }
  check(
    bytes <= 262144 &&
      JSON.stringify(next.files) ===
        JSON.stringify(
          plan.sources.map((item) => {
            const source = object(item)
            return { relative: source.relative, sha256: source.sha256, classification: "general", review: "approved" }
          }),
        ),
    "Prospective sources refused",
  )
  const preview = child(child(decoded.tree, "result"), "preview")
  check(sha(canonical(preview, decoded.text)) === value.preview_sha256, "Exact preview digest refused")
  check(
    sha(canonical(child(preview, "policy"), decoded.text, true) + "\n") === plan.prospective_policy_sha256,
    "Prospective policy digest refused",
  )
  // This is exact original metadata, not a new ownership grant. Never use the
  // ordinary JS Number projection to reconstruct Python generation hashes.
  generations.set(value, Object.freeze(original))
}

function publication(value: { [key: string]: Value }, op: Op) {
  fields(
    value,
    op === "approve"
      ? ["status", "policy_sha256", "revision", "enabled", "sync_started", "capture_enabled"]
      : ["status", "policy_sha256", "revision", "enabled", "capture_enabled", "host_join_required"],
  )
  hash(value.policy_sha256)
  integer(value.revision, 1)
  check(typeof value.enabled === "boolean" && value.capture_enabled === false, "Policy result refused")
  check(
    op === "approve"
      ? value.status === "policy_published" && value.sync_started === false
      : value.status === "policy_disabled" && value.enabled === false && value.host_join_required === true,
    "Policy operation refused",
  )
}
