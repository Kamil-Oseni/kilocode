type Row = Record<string, unknown>
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
const bytes = (value: string) => new TextEncoder().encode(value).length
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Media object required")
  return value as Row
}

function fields(row: Row, names: readonly string[]) {
  if (Object.keys(row).sort().join() !== [...names].sort().join()) throw new Error("Media fields differ")
}

function source(item: Row, root: string) {
  if (!hash(item.id) || item.sha256 !== item.id) throw new Error("Media evidence binding differs")
  const kind = item.kind
  if (kind !== "image" && kind !== "audio" && kind !== "video") throw new Error("Unsupported media kind")
  const suffix = typeof item.relative === "string" ? item.relative.slice(item.relative.lastIndexOf(".")) : ""
  const allowed = kind === "image" ? [".png", ".jpg"] : kind === "audio" ? [".wav"] : [".avi", ".mp4"]
  if (
    !allowed.includes(suffix) ||
    item.relative !== "Assets/" + item.id + suffix ||
    typeof item.path !== "string" ||
    normalize(item.path) !== normalize(root) + "/" + item.relative.toLowerCase()
  )
    throw new Error("Media snapshot escaped its selected content address")
  return { id: item.id, kind, path: item.path, relative: item.relative as string }
}

function metadata(item: Row) {
  if (
    typeof item.title !== "string" ||
    bytes(item.title) > 2048 ||
    typeof item.origin !== "string" ||
    bytes(item.origin) > 16384 ||
    !finite(item.imported) ||
    item.imported < 0 ||
    !finite(item.similarity) ||
    Math.abs(item.similarity) > 1.001
  )
    throw new Error("Media source metadata is invalid")
  return { title: item.title, similarity: item.similarity }
}

function verdict(item: Row, status: string, query: string) {
  if (item.query_sha256 !== query || item.verification !== status) throw new Error("Media evidence binding differs")
  if (
    typeof item.evidence !== "string" ||
    bytes(item.evidence) > 4096 ||
    typeof item.verifier !== "string" ||
    !item.verifier.trim() ||
    item.verifier.length > 256 ||
    (status === "supported" && !item.evidence.trim())
  )
    throw new Error("Media evidence is invalid")
  return { verification: status, evidence: item.evidence, verifier: item.verifier, query_sha256: query }
}

function span(item: Row, kind: string) {
  if (kind === "image") {
    if ((item.start ?? null) !== null || (item.end ?? null) !== null) throw new Error("Media timestamp span is invalid")
    return { start: null, end: null }
  }
  if (!finite(item.start) || !finite(item.end) || item.start < 0 || item.start >= item.end || item.end > 60)
    throw new Error("Media timestamp span is invalid")
  return { start: item.start, end: item.end }
}

/** Display projection only. The original service and model owners must establish source freshness and settlement. */
export function media(value: unknown, selection: { root: string; query: string; top: number }) {
  if (
    !/^[a-z]:[\\/]/i.test(selection.root) ||
    /[\x00-\x1f]/.test(selection.root) ||
    selection.root.length > 4096 ||
    !hash(selection.query) ||
    !Number.isSafeInteger(selection.top) ||
    selection.top < 1 ||
    selection.top > 10
  )
    throw new Error("Selected media root, query digest and result bound required")
  const row = object(value)
  fields(row, ["format", "query_sha256", "matches", "rejected", "uncertain"])
  if (row.format !== "raya.media.recall.v1" || row.query_sha256 !== selection.query)
    throw new Error("Media reply belongs to a different query")
  const seen = new Set<string>()
  const groups = (["matches", "rejected", "uncertain"] as const).map((name) => {
    const list = row[name]
    if (!Array.isArray(list) || list.length > selection.top) throw new Error("Media result bound exceeded")
    const status = name === "matches" ? "supported" : name === "rejected" ? "rejected" : "uncertain"
    return Object.freeze(
      list.map((value: unknown) => {
        const item = object(value)
        fields(item, [
          "id",
          "kind",
          "relative",
          "sha256",
          "title",
          "origin",
          "imported",
          "similarity",
          "path",
          "verification",
          "evidence",
          "verifier",
          "query_sha256",
          ...(Object.hasOwn(item, "start") || Object.hasOwn(item, "end") ? ["start", "end"] : []),
        ])
        const bound = source(item, selection.root)
        const info = metadata(item)
        const evidence = verdict(item, status, selection.query)
        const time = span(item, bound.kind)
        const identity = bound.id + ":" + time.start + ":" + time.end
        if (seen.has(identity) || seen.size >= selection.top) throw new Error("Duplicate or excessive media evidence")
        seen.add(identity)
        return Object.freeze({
          ...bound,
          ...info,
          ...evidence,
          ...time,
          source_sha256: bound.id,
        })
      }),
    )
  })
  return Object.freeze({ matches: groups[0], rejected: groups[1], uncertain: groups[2] })
}
