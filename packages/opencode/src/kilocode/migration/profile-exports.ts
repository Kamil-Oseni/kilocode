import { Database } from "bun:sqlite"
import { lstat } from "node:fs/promises"
import { database as validateDatabase } from "./profile-file"
import { createHash } from "node:crypto"
import { zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { ExportEventTypes } from "../session-export/envelope"

const text = z.string().max(1_048_576)
const id = z.string().min(1).max(1024)
const integer = z.number().int().safe().nonnegative()
const json = text.refine((value) => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}, "Invalid export event JSON")
const event = z
  .object({
    id,
    schema_version: z.literal(1),
    session_id: id,
    root_session_id: id,
    parent_session_id: id.nullable(),
    seq: integer,
    request_id: id.nullable(),
    type: z.enum(ExportEventTypes),
    ts: integer,
    agent_version: id,
    data_json: json,
    client_scrubbed: z.literal(1),
    uploaded_at: integer.nullable(),
    upload_attempts: integer,
    next_attempt_at: integer.nullable(),
  })
  .strict()
const chunk = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .string()
      .max(22_369_624)
      .refine((value) => Buffer.from(value, "base64").toString("base64") === value),
    size: integer.max(16_777_216),
    encoding: z.literal("zstd"),
    ref_count: integer,
    uploaded_at: integer.nullable(),
  })
  .strict()

/** Inert review evidence; restore must never insert this into the active uploader database. */
export const exports = z
  .object({
    format: z.literal("raya.session-export-evidence"),
    version: z.literal(1),
    events: z.array(event).max(100_000),
    chunks: z.array(chunk).max(10_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const rows of [value.events, value.chunks])
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        ctx.addIssue({ code: "custom", message: "Duplicate export artifact identity" })
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > 67_108_864 ||
      value.chunks.reduce((sum, row) => sum + row.size, 0) > 67_108_864
    ) {
      ctx.addIssue({ code: "custom", message: "Export artifact archive exceeds limit" })
      return
    }
    for (const row of value.chunks) {
      try {
        const bytes = zstdDecompressSync(Buffer.from(row.bytes, "base64"), { maxOutputLength: Math.max(1, row.size) })
        if (bytes.byteLength !== row.size || createHash("sha256").update(bytes).digest("hex") !== row.id)
          ctx.addIssue({ code: "custom", message: "Export chunk content identity differs" })
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid bounded export chunk" })
      }
    }
    const ids = new Set(value.chunks.map((row) => row.id))
    const keys = new Set(["chunkIds", "patchChunkIds", "inputChunkIds", "outputChunkIds"])
    const pending: unknown[] = []
    for (const row of value.events) {
      try {
        pending.push(JSON.parse(row.data_json))
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid export event JSON" })
        return
      }
    }
    let count = 0
    while (pending.length) {
      if (++count > 100_000) {
        ctx.addIssue({ code: "custom", message: "Export artifact structure exceeds limit" })
        break
      }
      const item = pending.pop()
      if (!item || typeof item !== "object") continue
      for (const [key, child] of Object.entries(item)) {
        if (keys.has(key) && Array.isArray(child) && child.some((ref) => typeof ref !== "string" || !ids.has(ref)))
          ctx.addIssue({ code: "custom", message: "Export event references absent chunks" })
        if (child && typeof child === "object") pending.push(child)
      }
    }
  })

/** Maintenance reader only. The caller must hold capture gates for this exact canonical database. */
export async function evidence(file: string) {
  const stat = await lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268_435_456)
    throw new Error("Unverified session export database")
  await validateDatabase(file)
  const db = new Database(file, { readonly: true, strict: true })
  try {
    db.exec("BEGIN")
    for (const table of ["event", "chunk"] as const) {
      const rows = db.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all()
      const names =
        table === "event" ? Object.keys(event.shape) : ["id", "bytes", "size", "encoding", "ref_count", "uploaded_at"]
      if (rows.length !== names.length || rows.some((row, index) => row.name !== names[index]))
        throw new Error("Unsupported session export schema")
    }
    const size = db
      .query<
        { size: number },
        []
      >("SELECT COALESCE((SELECT SUM(length(data_json)) FROM event),0) + COALESCE((SELECT SUM(length(bytes)) FROM chunk),0) AS size")
      .get()
    if (!size || size.size > 50_331_648) throw new Error("Export artifact native bytes exceed limit")
    const events = db.query("SELECT * FROM event ORDER BY id LIMIT 100001").all()
    const chunks = db
      .query("SELECT * FROM chunk ORDER BY id LIMIT 10001")
      .all()
      .map((row) => {
        const value = z
          .object({ bytes: z.instanceof(Uint8Array) })
          .passthrough()
          .parse(row)
        return { ...value, bytes: Buffer.from(value.bytes).toString("base64") }
      })
    const value = exports.parse({ format: "raya.session-export-evidence", version: 1, events, chunks })
    db.exec("COMMIT")
    return value
  } finally {
    db.close()
  }
}
