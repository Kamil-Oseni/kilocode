// raya_change - durable global self-healing feedback backlog
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"

export namespace RayaSelfHeal {
  export const Category = Schema.Literals([
    "ui",
    "chat",
    "routing",
    "goal",
    "browser",
    "settings",
    "build",
    "test",
    "docs",
    "other",
  ])
  export type Category = typeof Category.Type

  export const Status = Schema.Literals([
    "triaged",
    "queued",
    "in_progress",
    "verified",
    "blocked",
    "duplicate",
    "cancelled",
  ])
  export type Status = typeof Status.Type

  export const Severity = Schema.Literals(["low", "medium", "high"])
  export type Severity = typeof Severity.Type

  export const Evidence = Schema.Struct({
    summary: Schema.String,
    command: Schema.optional(Schema.String),
    artifact: Schema.optional(Schema.String),
    at: Schema.Number,
  })

  export const Item = Schema.Struct({
    id: Schema.String,
    fingerprint: Schema.String,
    title: Schema.String,
    description: Schema.String,
    category: Category,
    severity: Severity,
    explanation: Schema.String,
    approach: Schema.String,
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    reports: Schema.Number,
    reporterSessionID: Schema.optional(SessionID),
    workSessionID: Schema.optional(SessionID),
    blockedReason: Schema.optional(Schema.String),
    evidence: Schema.Array(Evidence),
    reloadRequired: Schema.Boolean,
    notifiedAt: Schema.optional(Schema.Number),
    duplicateOf: Schema.optional(Schema.String), // raya_change - canonical item this report duplicates
    classifiedBy: Schema.optional(Schema.Literals(["keyword", "model"])), // raya_change - who set the current category/severity
  })
  export type Item = typeof Item.Type

  export const Create = Schema.Struct({
    description: Schema.String,
    reporterSessionID: Schema.optional(SessionID),
  })

  export const Update = Schema.Struct({
    status: Schema.optional(Status),
    workSessionID: Schema.optional(SessionID),
    blockedReason: Schema.optional(Schema.String),
    evidence: Schema.optional(Schema.Array(Evidence)),
    reloadRequired: Schema.optional(Schema.Boolean),
    notifiedAt: Schema.optional(Schema.Number),
    // raya_change start - hybrid classification: the repair agent sharpens the deterministic
    // keyword triage from inside the session that is already open, at zero intake cost.
    category: Schema.optional(Category),
    severity: Schema.optional(Severity),
    approach: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    explanation: Schema.optional(Schema.String),
    duplicateOf: Schema.optional(Schema.String),
    classifiedBy: Schema.optional(Schema.Literals(["keyword", "model"])),
    // raya_change end
  })

  export class InputError extends Schema.TaggedErrorClass<InputError>()("RayaSelfHeal.InputError", {
    message: Schema.String,
  }) {}

  const prefix = ["raya", "self-heal", "item"]
  const key = (id: string) => [...prefix, id]
  const decode = Schema.decodeUnknownEffect(Item)
  const retention = 30 * 24 * 60 * 60 * 1000 // raya_change - terminal feedback expires after one month
  const terminal = new Set<Status>(["verified", "duplicate", "cancelled"])
  const expired = (item: Item) => terminal.has(item.status) && item.updatedAt < Date.now() - retention
  const clean = (value: string) => value.trim().replace(/\s+/g, " ")
  const normalized = (value: string) =>
    clean(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
  const fingerprint = (value: string) => Bun.hash(normalized(value)).toString(16)

  const profiles: Array<{ category: Category; pattern: RegExp; approach: string }> = [
    {
      category: "routing",
      pattern: /\b(?:route|router|agent|model|specialist|chief)\b/i,
      approach: "Reproduce the classification, inspect the decision evidence, then add a routing regression.",
    },
    {
      category: "goal",
      pattern: /\b(?:goal|loop|steer|discard|checkpoint|progress)\b/i,
      approach:
        "Reproduce the goal lifecycle, repair persisted state transitions, and verify rollback and termination.",
    },
    {
      category: "browser",
      pattern: /\b(?:browser|page|website|click|navigate|captcha)\b/i,
      approach:
        "Reproduce in the browser harness, repair the host/runtime boundary, and run an authenticated smoke test.",
    },
    {
      category: "settings",
      pattern: /\b(?:setting|config|provider|key|secret|import|export)\b/i,
      approach: "Trace the persisted setting through UI, secret storage, config, and runtime consumption.",
    },
    {
      category: "build",
      pattern: /\b(?:build|compile|package|vsix|install|startup|crash)\b/i,
      approach:
        "Reproduce with the smallest build command, fix the owning package, then package and launch the result.",
    },
    {
      category: "test",
      pattern: /\b(?:test|flake|timeout|assert|smoke)\b/i,
      approach:
        "Reproduce the failure without mocks, repair the implementation or unstable boundary, and rerun the suite.",
    },
    {
      category: "docs",
      pattern: /\b(?:documentation|docs|guide|readme|changelog)\b/i,
      approach: "Reconcile the prose with current behavior and verify every referenced command and path.",
    },
    {
      category: "chat",
      pattern: /\b(?:chat|message|composer|response|stream|markdown|tool call)\b/i,
      approach:
        "Capture the transcript and state sequence, repair rendering or transport, and add a conversation regression.",
    },
    {
      category: "ui",
      pattern: /\b(?:ui|ux|layout|font|color|button|panel|screen|visual)\b/i,
      approach:
        "Reproduce in the preview harness, fix the shared visual primitive, and compare light and dark screenshots.",
    },
  ]

  const classify = (description: string) => profiles.find((item) => item.pattern.test(description))
  const severity = (description: string): Severity => {
    if (/\b(?:data loss|security|crash|unusable|cannot|can't|blocked|infinite|loops?)\b/i.test(description))
      return "high"
    if (/\b(?:wrong|broken|failed|doesn't|does not|missing)\b/i.test(description)) return "medium"
    return "low"
  }
  const title = (description: string) => {
    const first = clean(description).split(/(?<=[.!?])\s/)[0]
    return first.length <= 100 ? first : `${first.slice(0, 97)}...`
  }

  export function make(storage: Pick<Storage.Interface, "list" | "read" | "write" | "remove">) {
    const list = Effect.fn("RayaSelfHeal.list")(function* () {
      const keys = yield* storage.list(prefix).pipe(Effect.orDie)
      const rows = yield* Effect.forEach(keys, (path) =>
        storage.read<unknown>(path).pipe(
          Effect.flatMap(decode),
          Effect.map((item) => ({ path, item })),
          Effect.orDie,
        ),
      )
      const stale = rows.filter((row) => expired(row.item))
      yield* Effect.forEach(stale, (row) => storage.remove(row.path).pipe(Effect.orDie), { discard: true })
      return rows
        .filter((row) => !expired(row.item))
        .map((row) => row.item)
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
    })

    const get = Effect.fn("RayaSelfHeal.get")(function* (id: string) {
      const item = yield* storage.read<unknown>(key(id)).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (!item || !expired(item)) return item
      yield* storage.remove(key(id)).pipe(Effect.orDie)
      return undefined // raya_change - lazy cleanup keeps persistence bounded without timers
    })

    const create = Effect.fn("RayaSelfHeal.create")(function* (input: typeof Create.Type) {
      const description = clean(input.description)
      if (description.length < 8) return yield* new InputError({ message: "Describe the issue in more detail." })
      const hash = fingerprint(description)
      const existing = (yield* list()).find(
        (item) => item.fingerprint === hash && !["verified", "cancelled", "duplicate"].includes(item.status),
      )
      const now = Date.now()
      if (existing) {
        const next = { ...existing, reports: existing.reports + 1, updatedAt: now }
        yield* storage.write(key(existing.id), next).pipe(Effect.orDie)
        return next
      }
      const profile = classify(description)
      const category = profile?.category ?? "other"
      const item: Item = {
        id: `heal_${crypto.randomUUID()}`,
        fingerprint: hash,
        title: title(description),
        description,
        category,
        severity: severity(description),
        explanation: `Raya categorized this as ${category} feedback. It remains globally visible until verified or explicitly closed.`,
        approach:
          profile?.approach ??
          "Reproduce the report, locate the owning boundary, implement the smallest complete repair, and attach verification evidence.",
        status: "triaged",
        createdAt: now,
        updatedAt: now,
        reports: 1,
        reporterSessionID: input.reporterSessionID,
        evidence: [],
        reloadRequired: false,
      }
      yield* storage.write(key(item.id), item).pipe(Effect.orDie)
      return item
    })

    const update = Effect.fn("RayaSelfHeal.update")(function* (id: string, input: typeof Update.Type) {
      const item = yield* get(id)
      if (!item) return
      const next: Item = {
        ...item,
        ...input,
        id: item.id,
        fingerprint: item.fingerprint,
        updatedAt: Date.now(),
        evidence: (input.evidence ?? item.evidence).slice(-50),
      } // raya_change - bound repeated verification evidence without losing the newest records
      yield* storage.write(key(id), next).pipe(Effect.orDie)
      return next
    })

    return { create, get, list, update }
  }
}
