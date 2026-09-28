import { Schema } from "effect"
import { local } from "./destination"

const ID = Schema.String.check(
  Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,128}$/.test(value) && value.trim() === value),
)
export const Result = Schema.Struct({
  version: Schema.Literal(2),
  delegationID: ID,
  receiptID: ID,
  kind: Schema.Literals(["delegation.result", "thinking", "commentary"]),
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.length > 0 &&
        Buffer.byteLength(value, "utf8") <= 500 &&
        Buffer.from(value, "utf8").toString("utf8") === value,
    ),
  ),
  ttl: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86400000 })),
  created: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    ),
  ),
}).check(
  Schema.makeFilter((value) =>
    exact(value, ["version", "delegationID", "receiptID", "kind", "content", "ttl", "created"]),
  ),
)
const Ack = Schema.Struct({
  version: Schema.Literal(2),
  sessionID: ID,
  delegationID: ID,
  receiptID: ID,
  accepted: Schema.Literal(true),
  played: Schema.Literal(false),
}).check(
  Schema.makeFilter((value) =>
    exact(value, ["version", "sessionID", "delegationID", "receiptID", "accepted", "played"]),
  ),
)

export class ResultError extends Error {
  constructor(readonly status: "refused" | "unknown") {
    super(
      status === "refused"
        ? "Media result delivery was refused."
        : "Media result acceptance is unconfirmed; do not replay.",
    )
    this.name = "ResultError"
  }
}

function exact(value: unknown, fields: string[]) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

/** One delivery attempt to the original managed media owner; acceptance is never playback. */
export async function send(
  url: string,
  id: string,
  key: string,
  token: string,
  item: typeof Result.Type,
  signal?: AbortSignal,
) {
  const origin = local(url)
  if (
    !origin ||
    (url !== origin && url !== `${origin}/`) ||
    !Schema.is(ID)(id) ||
    !Schema.is(ID)(key) ||
    !Schema.is(ID)(token) ||
    key.length !== 43 ||
    token.length !== 43 ||
    !Schema.is(Result)(item) ||
    !exact(item, ["version", "delegationID", "receiptID", "kind", "content", "ttl", "created"])
  )
    throw new ResultError("refused")
  const remaining = item.ttl > 0 ? Date.parse(item.created) + item.ttl - Date.now() : 1000
  if (remaining <= 0 || signal?.aborted) throw new ResultError("refused")
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(1000, Math.floor(remaining))))
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (lifetime.aborted) throw new ResultError("refused")
  const response = await fetch(`${origin}/v1/sessions/${encodeURIComponent(id)}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Raya-Media-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(item),
    redirect: "manual",
    signal: lifetime,
  }).catch(() => {
    throw new ResultError("unknown")
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {
      throw new ResultError("unknown")
    })
    throw new ResultError([400, 401, 403, 404, 422].includes(response.status) ? "refused" : "unknown")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ResultError("unknown")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new ResultError("unknown")
      })
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2048) throw new ResultError("unknown")
      chunks.push(chunk.value)
    }
    const raw = Buffer.concat(chunks)
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
    if (
      !Schema.is(Ack)(value) ||
      !exact(value, ["version", "sessionID", "delegationID", "receiptID", "accepted", "played"]) ||
      value.sessionID !== id ||
      value.delegationID !== item.delegationID ||
      value.receiptID !== item.receiptID
    )
      throw new ResultError("unknown")
    return value
  } catch {
    throw new ResultError("unknown")
  } finally {
    await reader.cancel().catch(() => {
      throw new ResultError("unknown")
    })
    reader.releaseLock()
  }
}
