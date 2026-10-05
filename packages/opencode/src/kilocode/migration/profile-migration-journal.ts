import { createHash } from "node:crypto"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import z from "zod"

const ids = migrations.map((migration) => migration.id)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const row = z.object({ id: z.string().min(1).max(256), time_completed: z.number().int().safe().nonnegative() }).strict()
export const journal = z
  .object({
    format: z.literal("raya.inactive-migration-journal"),
    version: z.literal(1),
    catalog: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(row).max(256),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    activation: z.literal("inert"),
    reconstruction: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.catalog !== hash(ids) ||
      JSON.stringify(value.rows.map((entry) => entry.id)) !== JSON.stringify(ids) ||
      value.digest !== hash(value.rows)
    )
      ctx.addIssue({ code: "custom", message: "Inactive migration journal catalog or rows differ" })
  })

/** Preserve source completion times as evidence; never install them as destination migration authority. */
export function captureJournal(values: unknown) {
  const parsed = z.array(row).max(256).safeParse(values)
  if (
    !parsed.success ||
    parsed.data.length !== ids.length ||
    new Set(parsed.data.map((entry) => entry.id)).size !== ids.length
  )
    return undefined
  const rows = ids.map((id) => parsed.data.find((entry) => entry.id === id))
  if (rows.some((entry) => entry === undefined)) return undefined
  return journal.parse({
    format: "raya.inactive-migration-journal",
    version: 1,
    catalog: hash(ids),
    rows,
    digest: hash(rows),
    activation: "inert",
    reconstruction: false,
  })
}
