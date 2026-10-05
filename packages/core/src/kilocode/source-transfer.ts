import path from "node:path"
import z from "zod"
import { IdentitySchema } from "./source-pipe"
import { DescriptorSchema } from "./source-capsule"

const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"))
const request = z
  .object({
    format: z.literal("raya.source-export"),
    version: z.literal(1),
    id: z.string().uuid(),
    source: IdentitySchema,
    host: DescriptorSchema.optional(),
    profile: z
      .object({
        database: file,
        storage: file,
        data: file.optional(),
        preferences: z
          .object({ config: file.optional(), modelState: file.optional(), extensionState: file.optional() })
          .strict()
          .optional(),
        exports: file.optional(),
      })
      .strict(),
    password: z.string().min(12).max(1024),
    output: file,
  })
  .strict()
export type Transfer = z.infer<typeof request>

/** This payload belongs only on the authenticated private pipe, never in argv/env/receipts. */
export function encode(value: Transfer) {
  const parsed = request.safeParse(value)
  if (!parsed.success) throw new Error("Invalid source export request")
  const text = JSON.stringify(parsed.data)
  if (Buffer.byteLength(text) > 4096) throw new Error("Source export request exceeds private channel bound")
  return text
}

export function decode(text: string): Transfer {
  if (Buffer.byteLength(text) > 4096) throw new Error("Source export request exceeds private channel bound")
  const value = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("Invalid source export request")
    }
  })()
  const parsed = request.safeParse(value)
  if (!parsed.success) throw new Error("Invalid source export request")
  return parsed.data
}
