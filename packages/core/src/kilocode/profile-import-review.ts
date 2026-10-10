import path from "node:path"
import z from "zod"

const source = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value) && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)))
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f\x7f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
  )
const workspace = z.discriminatedUnion("kind", [
  z.object({ source, kind: z.literal("ordinary") }).strict(),
  z
    .object({
      source,
      kind: z.literal("managed"),
      project: relative.refine((value) => !value.includes("/")),
      name: relative.refine((value) => !value.includes("/")),
      destination: z.tuple([z.literal("data"), z.literal("kilo"), z.literal("worktree"), relative, relative]),
    })
    .strict()
    .refine((value) => value.destination[3] === value.project && value.destination[4] === value.name),
])

/** Inspection metadata is never restore approval or imported execution authority. */
export const ImportReviewSchema = z
  .object({
    format: z.literal("raya.profile-import-review"),
    version: z.literal(1),
    archive: z
      .object({
        id: z.string().uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .positive()
          .max(180 * 1024 * 1024),
      })
      .strict(),
    workspaces: z.array(workspace).max(128),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
    activation: z.literal("held"),
    replay: z.literal(false),
    reconnectCredentials: z.literal(true),
    uncertainWork: z.literal("held-no-replay"),
  })
  .strict()
  .refine((value) => new Set(value.workspaces.map((item) => item.source)).size === value.workspaces.length)
