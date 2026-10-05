import path from "node:path"
import z from "zod"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const reference = z.object({ archive: z.string().uuid(), archiveDigest: digest }).strict()
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const projection = reference
  .safeExtend({
    prior: z.array(reference).max(64),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(128 * 1024 * 1024),
    digest,
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.prior.map((item) => item.archive)).size !== value.prior.length ||
      value.prior.some((item) => item.archive === value.archive)
    )
      ctx.addIssue({ code: "custom", message: "Restored source archive references are ambiguous" })
  })
export const restoredSources = z
  .array(projection)
  .max(64)
  .superRefine((values, ctx) => {
    if (new Set(values.map((value) => value.archive)).size !== values.length)
      ctx.addIssue({ code: "custom", message: "Duplicate restored source projection" })
    if (values.reduce((bytes, value) => bytes + value.bytes, 0) > 128 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Restored source projections exceed shared bound" })
  })
export const restoredSource = z
  .object({
    kind: z.literal("restored-source"),
    archive: z.string().uuid(),
    archiveDigest: digest,
    projectionDigest: digest,
    data: absolute,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(128 * 1024 * 1024),
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
