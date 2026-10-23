import { z } from "zod/v4"
import { preferences } from "@opencode-ai/core/kilocode/profile-preferences"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(512)
const model = z.object({ providerID: identifier, modelID: identifier }).strict()
const picks = z.array(model).max(1000)
const variants = z
  .array(model.extend({ agent: identifier.optional(), variant: z.union([z.literal(""), identifier]) }).strict())
  .max(128)
const agents = z.array(model.extend({ agent: identifier }).strict()).max(1000)
const models = z
  .object({
    selected: model.optional(),
    recent: picks,
    favorite: picks,
    agents,
    variants: variants.optional(),
    expanded: z.boolean().optional(),
  })
  .strict()
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const captured = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), preferences }).strict(),
  z
    .object({
      kind: z.literal("host"),
      id: z.string().uuid(),
      role: z.enum(["view", "agent-manager"]),
      revision,
      models,
      owners: z.array(z.object({ id: z.string().uuid(), revision, models: models.optional() }).strict()).max(256),
    })
    .strict(),
])

export const Choices = z
  .discriminatedUnion("state", [
    z.object({ version: z.literal(1), state: z.literal("absent") }).strict(),
    z
      .object({
        version: z.literal(1),
        state: z.literal("unavailable"),
        error: z.literal("Saved model choices are unavailable. Repair the saved evidence before applying choices."),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        state: z.literal("ready"),
        revision: digest,
        sources: z.array(captured).max(65),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.state !== "ready") return
    const hosts = value.sources.filter((source) => source.kind === "host")
    if (new Set(hosts.map((source) => source.id)).size !== hosts.length)
      ctx.addIssue({ code: "custom", message: "Saved host choices are ambiguous." })
    for (const source of hosts)
      if (new Set(source.owners.map((owner) => owner.id)).size !== source.owners.length)
        ctx.addIssue({ code: "custom", message: "Saved owner choices are ambiguous." })
    if (value.sources.filter((source) => source.kind === "profile").length > 1)
      ctx.addIssue({ code: "custom", message: "Saved profile choices are ambiguous." })
  })

export const Group = z.enum(["config", "models", "history", "client"])
export type Group = z.infer<typeof Group>

export const Application = z
  .object({
    id: z.string().uuid(),
    revision: digest,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("profile") }).strict(),
      z.object({ kind: z.literal("host"), id: z.string().uuid(), owner: z.string().uuid().optional() }).strict(),
    ]),
    expected: digest,
    groups: z
      .array(Group)
      .min(1)
      .max(4)
      .refine((value) => new Set(value).size === value.length),
    reviewed: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.source.kind === "host" &&
      !value.source.owner &&
      value.groups.some((group) => group === "models" || group === "history")
    )
      ctx.addIssue({ code: "custom", message: "Choose the saved owner for model bindings or history." })
  })
export type Application = z.infer<typeof Application>

export const Snapshot = z
  .object({
    id: z.string().uuid(),
    choices: Choices,
    destination: z.object({ version: z.literal(1), revision: digest, preferences }).strict(),
    availability: z
      .object({
        models: z.array(model.extend({ variants: z.array(identifier).max(128) }).strict()).max(10000),
        agents: z.array(identifier).max(1000),
      })
      .strict(),
  })
  .strict()
export type Snapshot = z.infer<typeof Snapshot>

export const Outcome = z
  .object({
    state: z.enum(["applied", "partial", "unknown"]),
    confirmed: z
      .array(Group)
      .max(4)
      .refine((value) => new Set(value).size === value.length),
    error: z.string().max(2048).optional(),
  })
  .strict()
export type Outcome = z.infer<typeof Outcome>

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
    choices: Choices.optional(),
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
  | { type: "restoreChoicesGet"; requestID: string }
  | { type: "restoreChoicesApply"; requestID: string; application: z.infer<typeof Application> }

export type RestoreResult =
  | { type: "restoreReviewResult"; requestID: string; summary?: Review; error?: string }
  | { type: "restoreChoicesResult"; requestID: string; snapshot?: Snapshot; outcome?: Outcome; error?: string }
