import z from "zod"
import type { disposition } from "./profile-disposition"
import { allocator } from "./profile-sql-allocator-schema"

export const sqlMetadata = z
  .object({
    format: z.literal("raya.inactive-profile-sqlite-allocators"),
    version: z.literal(1),
    installation: z.literal(false),
    entries: z
      .array(
        z
          .object({
            source: z.string().min(1).max(4096),
            component: z.enum(["sql", "exports", "store"]),
            id: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            allocator,
          })
          .strict(),
      )
      .min(1)
      .max(16384),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.entries.map((entry) => JSON.stringify([entry.source, entry.component, entry.id ?? null]))
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Duplicate archived SQLite allocator group" })
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Archived SQLite allocator ledger exceeds byte bound" })
  })

/** Render the existing inactive writer ledger; never install a source counter in a destination database. */
export function allocatorLedger(input?: z.output<typeof disposition>) {
  const groups = new Map<string, z.output<typeof sqlMetadata>["entries"][number]>()
  for (const file of input?.files ?? []) {
    const entry = file.disposition
    if (entry.kind !== "sqlite-semantic" || !entry.allocator) continue
    const key = JSON.stringify([entry.source, entry.component, entry.id ?? null])
    const value = { source: entry.source, component: entry.component, id: entry.id, allocator: entry.allocator }
    const prior = groups.get(key)
    if (prior && JSON.stringify(prior) !== JSON.stringify(value))
      throw new Error("Archived SQLite allocator groups have conflicting metadata")
    groups.set(key, value)
  }
  if (!groups.size) return undefined
  return sqlMetadata.parse({
    format: "raya.inactive-profile-sqlite-allocators",
    version: 1,
    installation: false,
    entries: [...groups.values()],
  })
}
