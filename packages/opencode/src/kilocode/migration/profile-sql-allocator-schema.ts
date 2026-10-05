import { createHash } from "node:crypto"
import z from "zod"

export const declaration =
  "CREATE TABLE `raya_composer_draft` ( `sequence` integer PRIMARY KEY AUTOINCREMENT, `id` text NOT NULL, `workspace` text NOT NULL, `project` text NOT NULL, `box` text NOT NULL, `record` text NOT NULL, `content_bytes` integer NOT NULL, `metadata_bytes` integer NOT NULL );"
export const normalize = (value: string) => value.replace(/\s+/g, " ").trim().replace(/;$/, "")
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const generation = hash(normalize(declaration))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const allocator = z
  .object({
    format: z.literal("raya.inactive-sqlite-allocator"),
    version: z.literal(1),
    schema: digest,
    generation: z.literal(generation),
    rows: z
      .array(
        z
          .object({
            name: z.literal("raya_composer_draft"),
            seq: z.number().int().safe().nonnegative(),
            highwater: z.number().int().safe().nonnegative(),
          })
          .strict(),
      )
      .max(1),
    digest,
    activation: z.literal("inert"),
    installation: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.digest !== hash(value.rows) || value.rows.some((row) => row.seq < row.highwater))
      ctx.addIssue({ code: "custom", message: "Inactive allocator counter binding differs" })
  })
