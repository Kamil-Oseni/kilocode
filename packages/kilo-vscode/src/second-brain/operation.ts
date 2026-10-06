import type { Node } from "jsonc-parser"
import { canonical, check, child, decode, object, sha } from "./control/frames"

type Value = ReturnType<typeof decode>["value"]
type Row = { [key: string]: Value }
type Identity = Readonly<{ request: string; epoch: string; release: string; digest: string }>
type Selection = Identity & Readonly<{ kind: "search" | "sync"; downstream?: readonly Identity[]; budget?: number }>
const counts = ["files", "chunks", "new_embeddings", "reused_embeddings"]
const common = [
  "format",
  "version",
  "request",
  "owner_epoch",
  "selected_release_sha256",
  "phase",
  "worker_created",
  "cleanup_outcome",
  "joins_observed",
  "queued_never_created",
  "receipt_sha256",
  "request_sha256",
  "inference_outcome",
]
const worker = [
  "root_exit",
  "job_active",
  "input_closed",
  "control_closed",
  "output_eof",
  "error_eof",
  "readers_joined",
  "original_handles_closed",
  "writer_joined",
]
const pending = ["format", "request", "owner_epoch", "selected_release_sha256", "kind", "request_sha256", "status"]

function fields(value: Value, keys: readonly string[]): Row {
  const row = object(value)
  const actual = Object.keys(row).sort()
  const expected = [...keys].sort()
  check(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    "Memory operation fields differ",
  )
  return row
}
function hex(value: Value, size = 64): asserts value is string {
  check(
    typeof value === "string" && new RegExp("^[a-f0-9]{" + size + "}$").test(value),
    "Memory operation identity differs",
  )
}
function identity(row: Row, selected: Identity) {
  hex(row.request, 32)
  hex(row.owner_epoch, 32)
  hex(row.selected_release_sha256)
  hex(row.request_sha256)
  check(
    row.request === selected.request &&
      row.owner_epoch === selected.epoch &&
      row.selected_release_sha256 === selected.release &&
      row.request_sha256 === selected.digest,
    "Memory original operation selection differs",
  )
}
function integer(row: Row, key: string, node: Node, text: string, max = Number.MAX_SAFE_INTEGER) {
  const value = row[key]
  const token = child(node, key)
  check(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= max &&
      /^(0|[1-9]\d*)$/.test(text.slice(token.offset, token.offset + token.length)),
    "Memory integer token differs",
  )
}
function without(node: Node, keys: readonly string[]): Node {
  return { ...node, children: node.children?.filter((item) => !keys.includes(item.children![0].value)) }
}
function ascii(node: Node, text: string) {
  // Python ensure_ascii also escapes DEL; the existing control codec's ASCII
  // range starts at U+0080. Keep that frozen v1 codec unchanged.
  return canonical(node, text, true).replace(/\u007f/g, "\\u007f")
}
function fingerprint(row: Row, node: Node, text: string) {
  hex(row.receipt_sha256)
  check(
    sha(ascii(without(node, ["receipt_sha256"]), text)) === row.receipt_sha256,
    "Memory terminal fingerprint differs",
  )
}
function outcome(row: Row, key: string) {
  check(
    typeof row[key] === "string" && ["completed", "failed", "cancelled"].includes(row[key]),
    "Memory operation outcome differs",
  )
  if (row[key] === "completed") hex(row.result_sha256)
}
function created(row: Row, node: Node, text: string) {
  check(
    row.cleanup_outcome === "joined" && row.joins_observed === true && row.queued_never_created === false,
    "Memory original worker joins are unconfirmed",
  )
  integer(row, "root_exit", node, text, 0xffffffff)
  integer(row, "job_active", node, text, 0)
  check(
    worker.filter((key) => key !== "root_exit" && key !== "job_active").every((key) => row[key] === true),
    "Memory original worker cleanup differs",
  )
}
function certificate(value: Value, node: Node, text: string, selected?: Identity) {
  const row = object(value)
  outcome(row, "inference_outcome")
  check(typeof row.worker_created === "boolean", "Memory worker evidence requires booleans")
  fields(row, [
    ...common,
    ...(row.inference_outcome === "completed" ? ["result_sha256"] : []),
    ...(row.worker_created ? worker : []),
  ])
  integer(row, "version", node, text, 1)
  check(
    row.format === "raya.retrieval.retirement" && row.version === 1 && row.phase === "retired",
    "Memory downstream protocol differs",
  )
  identity(
    row,
    selected ?? {
      request: String(row.request),
      epoch: String(row.owner_epoch),
      release: String(row.selected_release_sha256),
      digest: String(row.request_sha256),
    },
  )
  if (row.worker_created) created(row, node, text)
  if (!row.worker_created)
    check(
      row.cleanup_outcome === "not_started" && row.joins_observed === false && row.queued_never_created === true,
      "Memory never-created worker evidence differs",
    )
  fingerprint(row, node, text)
  return row
}
function downstream(row: Row, node: Node, text: string, selected: Selection) {
  check(Array.isArray(row.downstream) && row.downstream.length <= 1024, "Memory downstream proofs required")
  const nodes = child(node, "downstream").children ?? []
  const ids = new Set<string>()
  row.downstream.forEach((value, index) => {
    const current = object(value)
    hex(current.request, 32)
    check(!ids.has(current.request), "Memory duplicate downstream request")
    ids.add(current.request)
    const expected = selected.downstream?.find((item) => item.request === current.request)
    check(!selected.downstream || expected, "Memory downstream selection differs")
    certificate(current, nodes[index], text, expected)
  })
  if (selected.downstream)
    check(
      ids.size === selected.downstream.length && selected.downstream.every((item) => ids.has(item.request)),
      "Memory downstream selection is incomplete",
    )
}
function aggregate(row: Row, node: Node, text: string) {
  const value = fields(row.counts, counts)
  const current = child(node, "counts")
  counts.forEach((key) => integer(value, key, current, text))
  if (Object.hasOwn(row, "rebuilt")) check(row.rebuilt === true, "Memory rebuilt marker differs")
}
function terminal(row: Row, node: Node, text: string, selected: Selection) {
  outcome(row, "operation_outcome")
  fields(row, [
    ...pending,
    "operation_outcome",
    "downstream",
    "receipt_sha256",
    ...(row.operation_outcome === "completed" ? ["result_sha256"] : []),
    ...(row.operation_outcome === "completed" && row.kind === "sync" ? ["counts"] : []),
    ...(Object.hasOwn(row, "rebuilt") ? ["rebuilt"] : []),
  ])
  check(row.status === "terminal", "Memory operation is not terminal")
  check(
    !Object.hasOwn(row, "rebuilt") || (row.kind === "sync" && row.operation_outcome === "completed"),
    "Memory rebuilt operation differs",
  )
  if (row.operation_outcome === "completed" && row.kind === "sync") aggregate(row, node, text)
  downstream(row, node, text, selected)
  fingerprint(row, node, text)
}
function result(value: Value, selected: Selection) {
  const row = object(value)
  if (selected.kind === "sync") {
    fields(row, [...counts, ...(Object.hasOwn(row, "rebuilt") ? ["rebuilt"] : [])])
    check(!Object.hasOwn(row, "rebuilt") || row.rebuilt === true, "Memory rebuilt result differs")
    return row
  }
  fields(row, ["results", "capture_enabled", ...(selected.budget === undefined ? [] : ["context"])])
  check(
    row.capture_enabled === false && Array.isArray(row.results) && row.results.length <= 20,
    "Memory search result shape differs",
  )
  if (selected.budget !== undefined) {
    check(
      Number.isSafeInteger(selected.budget) &&
        selected.budget > 0 &&
        selected.budget <= 12000 &&
        row.results.length === 0,
      "Linked context requires an explicit budget and no unbudgeted search passages",
    )
    return row
  }
  row.results.forEach((item) =>
    fields(item, [
      "path",
      "relative",
      "line",
      "end_line",
      "heading",
      "text",
      "source_sha256",
      "embedding_similarity",
      "relevance_score",
    ]),
  )
  return row
}
function response(row: Row, node: Node, text: string, selected: Selection) {
  const projection = object(row)
  delete projection.operation
  const value = result(projection, selected)
  const operation = child(node, "operation")
  const record = object(decode(new TextEncoder().encode(canonical(operation, text) + "\n")).value)
  check(record.operation_outcome === "completed", "Memory successful result lacks completed operation")
  check(sha(ascii(without(node, ["operation"]), text)) === record.result_sha256, "Memory result fingerprint differs")
  if (selected.kind === "sync") {
    counts.forEach((key) => {
      integer(value, key, node, text)
      check(value[key] === object(record.counts)[key], "Memory aggregate counts differ")
    })
    check(value.rebuilt === record.rebuilt, "Memory aggregate rebuilt marker differs")
  }
  return value
}
function freeze(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

// This validates the selected producer's correlation metadata, not authenticated
// worker ownership. Numeric result tokens come from its original Python JSON
// response; never reconstruct these fingerprints from JS Number projections.
export function parse(raw: Uint8Array, selected: Selection, mode: "response" | "terminal" | "pending") {
  check(
    ["response", "terminal", "pending"].includes(mode) && ["search", "sync"].includes(selected.kind),
    "Memory operation selection mode differs",
  )
  check(raw.length > 0 && raw.length <= 262144, "Memory response exceeds its bound")
  const decoded = decode(raw[raw.length - 1] === 10 ? raw : new Uint8Array([...raw, 10]), 262145)
  const row = object(decoded.value)
  const node = mode === "response" ? child(decoded.tree, "operation") : decoded.tree
  check(Buffer.byteLength(canonical(node, decoded.text)) <= 65536, "Memory operation exceeds its publication bound")
  const operation = mode === "response" ? object(row.operation) : row
  check(
    operation.format === "raya.memory.operation.v1" && operation.kind === selected.kind,
    "Memory operation protocol differs",
  )
  identity(operation, selected)
  if (mode === "pending") {
    fields(operation, pending)
    check(operation.status === "pending", "Memory operation is not pending")
  }
  if (mode !== "pending") terminal(operation, node, decoded.text, selected)
  const value = mode === "response" ? response(row, decoded.tree, decoded.text, selected) : undefined
  return Object.freeze({
    operation: freeze(operation),
    ...(value ? { result: freeze(value) } : {}),
    qualification: "Selected producer correlation; no HMAC, native ownership or per-leaf parent proof",
  })
}
