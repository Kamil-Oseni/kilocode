import { z } from "zod"

export const marker = z
  .object({ format: z.literal("raya.restored-memory"), version: z.literal(1), hold: z.string().uuid() })
  .strict()
export const receipt = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    state: z.enum(["held", "released"]),
    createdAt: z.number().finite(),
    review: z.object({ at: z.number().finite(), by: z.literal("user") }).optional(),
  })
  .strict()
