import path from "node:path"
import z from "zod"
import { reviewContext } from "./profile-restore-review-schema"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const selector = z.enum([
  "config",
  "disposition",
  "secondary",
  "voice",
  "operational",
  "host",
  "tui",
  "preferences",
  "notes",
  "outputs",
  "selfHeal",
  "sqlMetadata",
  "review",
  "stores",
  "exports",
])
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
export const restoredComponent = z
  .object({
    kind: z.literal("restored-component"),
    archive: z.string().uuid(),
    archiveDigest: digest,
    componentDigest: digest,
    selector,
    data: absolute,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(64 * 1024 * 1024),
    digest,
    modified: z
      .string()
      .max(20)
      .regex(/^\d+$/)
      .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
      .optional(),
    activation: z.literal("inert"),
  })
  .strict()
export const restoredComponents = z
  .array(
    z
      .object({
        archive: z.string().uuid(),
        archiveDigest: digest,
        selector,
        componentDigest: digest,
        context: reviewContext.optional(),
        text: z
          .string()
          .max(64 * 1024 * 1024)
          .refine((value) => Buffer.byteLength(value) <= 64 * 1024 * 1024, "Restored component text exceeds byte bound")
          .refine((value) => {
            try {
              JSON.parse(value)
              return true
            } catch {
              return false
            }
          }, "Restored component text is not JSON"),
      })
      .strict(),
  )
  .max(320)
  .superRefine((value, ctx) => {
    if (new Set(value.map((item) => item.archive + ":" + item.selector)).size !== value.length)
      ctx.addIssue({ code: "custom", message: "Duplicate restored component projection" })
    if (value.reduce((size, item) => size + Buffer.byteLength(item.text), 0) > 128 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Restored component projection exceeds shared bound" })
  })
