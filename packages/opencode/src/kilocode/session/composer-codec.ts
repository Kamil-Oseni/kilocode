import { createHash } from "node:crypto"
import z from "zod"

const short = z.string().min(1).max(4096)
const line = z.number().int().positive()
const comment = z.discriminatedUnion("origin", [
  z
    .object({
      origin: z.literal("pr"),
      id: short,
      author: short,
      body: z.string().max(100_000),
      file: short.optional(),
      line: line.optional(),
      diffHunk: z.string().max(200_000).optional(),
      outdated: z.boolean().optional(),
      replies: z
        .array(z.object({ author: short, body: z.string().max(100_000) }).strict())
        .max(20)
        .optional(),
    })
    .strict(),
  z
    .object({
      origin: z.undefined().optional(),
      id: short,
      file: short,
      side: z.enum(["additions", "deletions"]),
      line,
      comment: z.string().max(100_000),
      selectedText: z.string().max(200_000),
    })
    .strict(),
])
const identity = z
  .object({
    key: short,
    box: short,
    workspace: short,
    projectID: short.optional(),
    sessionID: short.optional(),
    pendingID: short.optional(),
  })
  .strict()
const content = z
  .object({
    text: z.string().max(1_000_000),
    comments: z.array(comment).max(100),
    images: z
      .array(
        z
          .object({
            id: short,
            filename: short,
            mime: z
              .string()
              .max(255)
              .regex(/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/),
            dataUrl: z.string().max(12_000_000),
          })
          .strict(),
      )
      .max(16),
    scroll: z.number().finite().min(0),
    model: z.object({ providerID: short, modelID: short }).strict().optional(),
    agent: short.optional(),
    variant: short.optional(),
    selection: z
      .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.selection || (value.selection.start <= value.selection.end && value.selection.end <= value.text.length),
  )
const token = z
  .object({ generation: z.string().uuid(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
const entry = z
  .object({
    identity,
    token,
    content: content.nullable(),
    mutation: short,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: z
      .object({ request: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict()
const document = z.object({ version: z.literal(1), entries: z.array(entry).max(128) }).strict()

export type DraftIdentity = z.infer<typeof identity>
export type DraftContent = z.infer<typeof content>
export type DraftToken = z.infer<typeof token>
export type DraftEntry = z.infer<typeof entry>

export const DraftSchemas = { identity, content, token, entry }
export const DraftImported = z
  .object({
    version: z.literal(1),
    format: z.literal("raya.restored-composer-content"),
    id: z.string().uuid(),
    pendingProject: z.literal("destination"),
  })
  .strict()

const retired = z
  .object({
    version: z.literal(2),
    generation: z.string().uuid(),
    storage: z.string(),
    database: z.string(),
    source: z.string().regex(/^[a-f0-9]{64}$/),
    marker: z.string().regex(/^[a-f0-9]{64}$/),
    cursor: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Journal = {
  id: string
  generation: string
  storage: string
  database: string
  phase: string
  source: string | null
  source_digest: string
  marker: string | null
  marker_digest: string
  cursor_secret: string
  content_bytes: number
  metadata_bytes: number
}
const bytes = (value: string | null) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const overhead = (journal: Journal) =>
  Buffer.byteLength(journal.source ?? "") +
  Buffer.byteLength(journal.marker ?? "") +
  Buffer.byteLength(
    JSON.stringify({ ...journal, phase: "pending", source: null, marker: null, content_bytes: 0, metadata_bytes: 0 }),
  )
function journal(prior: Journal) {
  if (
    prior.source_digest !== bytes(prior.source) ||
    prior.marker_digest !== bytes(prior.marker) ||
    !/^[a-f0-9]{64}$/.test(prior.cursor_secret) ||
    !z.string().uuid().safeParse(prior.generation).success ||
    !["pending", "active"].includes(prior.phase) ||
    !Number.isSafeInteger(prior.content_bytes) ||
    !Number.isSafeInteger(prior.metadata_bytes) ||
    prior.content_bytes < 0 ||
    prior.metadata_bytes < overhead(prior) ||
    prior.content_bytes > 32 * 1024 * 1024 ||
    prior.metadata_bytes > 64 * 1024 * 1024
  )
    throw new DraftError("corrupt")
}
export const DraftRetirement = {
  schema: retired,
  overhead,
  validate: journal,
  encode: (journal: {
    generation: string
    storage: string
    database: string
    source_digest: string
    marker_digest: string
    cursor_secret: string
  }) => ({
    version: 2,
    generation: journal.generation,
    storage: journal.storage,
    database: journal.database,
    source: journal.source_digest,
    marker: journal.marker_digest,
    cursor: createHash("sha256").update(JSON.stringify(journal.cursor_secret)).digest("hex"),
  }),
}

/** Deliberately carries no draft text, attachment bytes, filenames or workspace paths. */
export class DraftError extends Error {
  constructor(readonly code: "invalid" | "corrupt" | "missing" | "conflict" | "capacity" | "admission") {
    super(`Composer draft persistence: ${code}`)
  }
}

const key = ["raya", "composer-drafts"]
const mark = ["raya", "composer-drafts-initialized"]
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const same = (left: DraftToken | undefined, right: DraftToken | undefined) =>
  left?.generation === right?.generation && left?.revision === right?.revision
const id = (value: DraftIdentity) => hash(identity.parse(value))
function parse<T>(schema: z.ZodType<T>, value: unknown, code: "invalid" | "corrupt" = "invalid"): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new DraftError(code)
  return result.data
}
function checked(value: unknown) {
  const data = parse(document, value, "corrupt")
  if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw new DraftError("capacity")
  const keys = data.entries.map((item) => id(item.identity))
  if (new Set(keys).size !== keys.length || data.entries.some((item) => item.digest !== hash(item.content)))
    throw new DraftError("corrupt")
  return data
}

/** Shared validated v1 import boundary; the SQL store never loosens legacy validation. */
export const DraftLegacy = { key, mark, hash, same, id, checked }
