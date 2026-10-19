import { z } from "zod"

const text = z.string().regex(/\S/).max(4000)
export const Final = z
  .object({
    kind: z.literal("file"),
    path: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^(?:\/|[a-zA-Z]:[\\/]|\\\\)[^\x00-\x1f\x7f]*$/),
    bytes: z.number().int().min(0).max(8192),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type Final = z.infer<typeof Final>
export const Output = z
  .object({
    destination: z.literal("conversation"),
    description: text,
    final: Final.optional(),
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
