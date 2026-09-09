// raya_change - durable global self-healing feedback backlog
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { createHash } from "node:crypto"
import { repairs, Outcome, Admission, Granted, Advance, Prepare } from "./repair"
import { Completion, completions } from "./completion"
import { SessionID } from "@/session/schema"

export namespace RayaSelfHeal {
  export const CompletionReceipt = Completion
  export const Repair = Schema.Struct({ ...Outcome.fields, completion: Schema.optional(Completion) })
  export const RepairAdmission = Admission
  export const RepairGranted = Granted
  export const RepairAdvance = Advance
  export const RepairPrepare = Prepare

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
    repair: Schema.optional(Outcome),
    completion: Schema.optional(Completion),
    legacyVerification: Schema.optional(Schema.Boolean),
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
  const terminal = new Set<Status>(["duplicate", "cancelled"])
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

  export function make(
    storage: Pick<Storage.Interface, "list" | "read" | "write" | "remove" | "create" | "replace">,
    root?: string,
  ) {
    const repair = repairs(storage, root)
    const completion = completions(storage, repair)
    const decorate = Effect.fn(function* (item: Item) {
      const receipts = yield* storage.list(["raya", "self-heal", "reports", item.id]).pipe(Effect.orDie)
      const baseline = yield* storage.read<number>(["raya", "self-heal", "reports", item.id, "base"]).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(item.reports)),
        Effect.orDie,
      )
      const reports = receipts.filter((key) => !key.some((part) => part.startsWith(".")) && key.at(-1) !== "base")
      const times = yield* Effect.forEach(reports, (key) =>
        storage.read<{ at: number }>(key).pipe(
          Effect.map((row) => row.at),
          Effect.orDie,
        ),
      )
      const tested = yield* completion.get(item.id)
      return {
        ...item,
        status: tested ? ("verified" as const) : item.status === "verified" ? ("blocked" as const) : item.status,
        legacyVerification: (!tested && (item.status === "verified" || item.legacyVerification)) || undefined,
        completion: tested,
        reloadRequired: false,
        reports: Math.max(item.reports, baseline + reports.length),
        updatedAt: times.reduce((latest, at) => Math.max(latest, at), item.updatedAt),
        repair: yield* repair.get(item.id),
      }
    })
    const list = Effect.fn("RayaSelfHeal.list")(function* () {
      const keys = yield* storage.list(prefix).pipe(Effect.orDie)
      const rows = yield* Effect.forEach(
        keys.filter((key) => !key.some((part) => part.startsWith("."))),
        (path) =>
          storage.read<unknown>(path).pipe(
            Effect.flatMap(decode),
            Effect.map((item) => ({ path, item })),
            Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
            Effect.orDie,
          ),
      )
      const checked = yield* Effect.forEach(
        rows.filter((row) => row !== undefined),
        (row) =>
          repair.get(row.item.id).pipe(Effect.map((attempt) => ({ ...row, stale: expired(row.item) && !attempt }))),
      )
      const stale = checked.filter((row) => row.stale)
      yield* Effect.forEach(
        stale,
        (row) =>
          Effect.gen(function* () {
            yield* storage.create(["raya", "self-heal", "closed", row.item.id], true).pipe(Effect.orDie)
            yield* storage.remove(row.path).pipe(Effect.orDie)
          }),
        { discard: true },
      )
      return yield* Effect.forEach(
        checked.filter((row) => !row.stale).map((row) => row.item),
        decorate,
      ).pipe(Effect.map((items) => items.toSorted((a, b) => b.updatedAt - a.updatedAt)))
    })

    const get = Effect.fn("RayaSelfHeal.get")(function* (id: string) {
      const item = yield* storage.read<unknown>(key(id)).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (!item) return
      if (!expired(item) || (yield* repair.get(id))) return yield* decorate(item)
      yield* storage.create(["raya", "self-heal", "closed", id], true).pipe(Effect.orDie)
      yield* storage.remove(key(id)).pipe(Effect.orDie)
      return undefined // raya_change - lazy cleanup keeps persistence bounded without timers
    })

    const create = Effect.fn("RayaSelfHeal.create")(function* (input: typeof Create.Type) {
      const description = clean(input.description)
      if (description.length < 8) return yield* new InputError({ message: "Describe the issue in more detail." })
      const hash = fingerprint(description)
      const now = Date.now()
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
      const seedkey = ["raya", "self-heal", "seed", item.id]
      yield* storage.create(seedkey, item).pipe(Effect.orDie)
      const canonical = createHash("sha256").update(normalized(description)).digest("hex")
      let generation = "initial"
      for (let index = 0; index < 100; index++) {
        const path = ["raya", "self-heal", "intake", canonical, generation]
        const legacy = (yield* list())
          .filter((row) => row.fingerprint === hash && !terminal.has(row.status))
          .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
        const candidate = { id: (legacy ?? item).id, baseline: legacy?.reports ?? 0 }
        yield* storage.create(path, candidate).pipe(Effect.orDie)
        const claim = yield* storage.read<typeof candidate>(path).pipe(Effect.orDie)
        const existing = yield* storage.read<Item>(key(claim.id)).pipe(
          Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
          Effect.orDie,
        )
        const closed = yield* storage.read<boolean>(["raya", "self-heal", "closed", claim.id]).pipe(
          Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(false)),
          Effect.orDie,
        )
        const attempt = yield* repair.get(claim.id)
        if (
          (closed || terminal.has(existing?.status ?? "triaged")) &&
          (!attempt || attempt.phase === "legacy_conflict")
        ) {
          generation = claim.id
          continue
        }
        const seed =
          existing ??
          (yield* storage.read<Item>(["raya", "self-heal", "seed", claim.id]).pipe(
            Effect.catchIf(Storage.NotFoundError.isInstance, () => storage.read<Item>(key(claim.id))),
            Effect.orDie,
          ))
        yield* storage.create(key(claim.id), seed).pipe(Effect.orDie)
        // Pending seed copies are removed only after complete item publication.
        yield* storage.remove(["raya", "self-heal", "seed", claim.id]).pipe(Effect.orDie)
        if (item.id !== claim.id) yield* storage.remove(seedkey).pipe(Effect.orDie)
        yield* storage.create(["raya", "self-heal", "reports", claim.id, "base"], claim.baseline).pipe(Effect.orDie)
        yield* storage
          .create(["raya", "self-heal", "reports", claim.id, crypto.randomUUID()], { at: now })
          .pipe(Effect.orDie)
        return yield* decorate(seed)
      }
      return yield* new InputError({ message: "Feedback history needs reconciliation before another intake." })
    })

    const update = Effect.fn("RayaSelfHeal.update")(function* (id: string, input: typeof Update.Type) {
      if (input.status === "verified" || input.reloadRequired === true)
        return yield* new InputError({
          message:
            "Verified completion requires an authoritative goal receipt; release and installation are not established by an update.",
        })
      const item = yield* get(id)
      if (!item) return
      if (input.workSessionID !== undefined && input.workSessionID !== (yield* repair.get(id))?.sessionID)
        return yield* new InputError({ message: "The repair session is assigned only by the durable repair journal." })
      const next: Item = {
        ...item,
        ...input,
        id: item.id,
        fingerprint: item.fingerprint,
        updatedAt: Date.now(),
        evidence: (input.evidence ?? item.evidence).slice(-50),
      } // raya_change - bound repeated verification evidence without losing the newest records
      yield* storage.replace(key(id), next).pipe(Effect.orDie)
      return yield* decorate(next)
    })

    const admit = Effect.fn(function* (id: string, input: typeof Admission.Type) {
      const item = yield* get(id)
      if (!item) return
      const matches = (yield* list()).filter((row) => row.fingerprint === item.fingerprint && !terminal.has(row.status))
      return yield* repair.admit(
        id,
        input.source,
        terminal.has(item.status) ||
          !!item.legacyVerification ||
          !!item.completion ||
          !!item.workSessionID ||
          matches.length > 1,
      )
    })
    const outcome = Effect.fn(function* (id: string) {
      const retained = yield* repair.get(id)
      if (!retained) return
      return { ...retained, completion: yield* completion.get(id) }
    })
    return {
      create,
      get,
      list,
      update,
      admit,
      advance: repair.advance,
      prepare: repair.prepare,
      outcome,
      link: completion.link,
      complete: completion.record,
    }
  }
}
