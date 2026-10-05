import { z } from "zod"

export const Review = z
  .object({
    state: z.enum(["absent", "held", "released"]),
    id: z.string().uuid().optional(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    review: z
      .object({
        at: z.number().finite(),
        by: z.literal("user"),
        revision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .optional(),
    reconnectCredentials: z.boolean(),
    uncertainWork: z.literal("held-no-replay"),
    workspaces: z
      .array(z.object({ source: z.string().min(1).max(4096), destination: z.string().min(1).max(4096) }).strict())
      .max(128),
    workers: z
      .array(
        z.object({ id: z.string().min(1).max(4096), name: z.string().min(1).max(4096), enabled: z.boolean() }).strict(),
      )
      .max(1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state !== "absent" && (!value.id || !value.revision))
      ctx.addIssue({ code: "custom", message: "Reload the transferred profile's review." })
    if (value.state === "released" && !value.review)
      ctx.addIssue({ code: "custom", message: "The profile's review receipt is missing." })
  })
export type Review = z.infer<typeof Review>

export const Approval = z
  .object({
    id: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
    workspacesAcknowledged: z.literal(true),
    reconnectAcknowledged: z.literal(true),
  })
  .strict()
export type Approval = z.infer<typeof Approval>

export type RestoreRequest =
  | { type: "restoreReviewGet"; requestID: string }
  | { type: "restoreReviewApprove"; requestID: string; approval: Approval }

export type RestoreResult = {
  type: "restoreReviewResult"
  requestID: string
  summary?: Review
  error?: string
}
