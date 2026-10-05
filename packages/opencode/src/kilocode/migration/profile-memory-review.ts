import { z } from "zod"
import { createHash } from "node:crypto"
import { marker, receipt } from "../../../../kilo-memory/src/storage/review-schema"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
/** Archived destination review metadata supplies no authorization to release a hold. */
export const memoryReview = z
  .object({
    marker,
    receipt,
    markerText: z.string().max(4096),
    receiptText: z.string().max(8192),
    markerDigest: digest,
    receiptDigest: digest,
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.marker.hold !== value.receipt.id)
      ctx.addIssue({ code: "custom", message: "Memory destination review identity differs" })
    for (const [schema, text, expected, parsed] of [
      [marker, value.markerText, value.markerDigest, value.marker],
      [receipt, value.receiptText, value.receiptDigest, value.receipt],
    ] as const) {
      try {
        if (
          createHash("sha256").update(text).digest("hex") !== expected ||
          JSON.stringify(schema.parse(JSON.parse(text))) !== JSON.stringify(parsed)
        )
          ctx.addIssue({ code: "custom", message: "Memory review source bytes differ" })
      } catch {
        ctx.addIssue({ code: "custom", message: "Memory review source schema differs" })
      }
    }
  })
