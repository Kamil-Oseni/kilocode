import { z } from "zod"

const text = z.string().regex(/\S/).max(4000)
export const Output = z
  .object({
    destination: z.literal("conversation"),
    description: text,
    criteria: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
            description: text,
            verification: text,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((value) => new Set(value.criteria.map((item) => item.id)).size === value.criteria.length, {
    message: "Criterion IDs must be unique.",
  })
export type Output = z.infer<typeof Output>
