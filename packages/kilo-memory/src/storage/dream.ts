import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { MemoryFs } from "./fs"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1).max(8000)
const relative = z
  .string()
  .max(512)
  .refine(
    (value) =>
      Boolean(value) &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
  )
const source = z.object({ path: relative, sha256: hash }).strict()
const candidate = z
  .object({
    fact: hash,
    kind: z.enum(["memory", "hypothesis", "lesson"]),
    sources: z.array(source).min(1).max(8),
    changes: z
      .array(
        z
          .object({
            path: relative.refine((value) => value.endsWith(".md")),
            expected: hash.nullable(),
            content: z.string().max(250000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    rationale: text,
    contradictions: z.array(text).max(16),
  })
  .strict()
const disposition = z
  .object({
    state: z.enum(["prepared", "submitting", "pending", "accepted", "rejected", "superseded", "deleted"]),
    at: z.number().int().nonnegative(),
    proposal: z.string().uuid().optional(),
    receipt: hash.optional(),
    reason: text.optional(),
  })
  .strict()
const row = z
  .object({
    fingerprint: hash,
    candidate,
    state: disposition.shape.state,
    proposal: z.string().uuid().optional(),
    receipt: hash.optional(),
    reason: text.optional(),
    history: z.array(disposition).min(1).max(8),
  })
  .strict()
const run = z
  .object({
    id: z.string().uuid(),
    owner: z.string().uuid(),
    phase: z.enum([
      "generation",
      "validation",
      "submission",
      "review-pending",
      "reconciliation",
      "completed",
      "cancelled",
      "failed",
    ]),
    model: text,
    sources: z.array(source).min(1).max(20),
    candidates: z.array(hash).max(20),
    started: z.number().int().nonnegative(),
    deadline: z.number().int().nonnegative(),
    budget: z.object({ input: z.number().int().min(1).max(12000), output: z.number().int().min(1).max(8000) }).strict(),
    reason: text.optional(),
  })
  .strict()
const schema = z
  .object({
    version: z.literal(1),
    project: z.string().min(1),
    scope: z.string().uuid().optional(),
    slots: z
      .array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/), path: relative }).strict())
      .max(128)
      .default([]),
    rows: z.array(row).max(128),
    tombstones: z.array(hash).max(128),
    runs: z.array(run).max(32).default([]),
  })
  .strict()

function compare(one: string, two: string) {
  return one < two ? -1 : one > two ? 1 : 0
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([one], [two]) => compare(one, two))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

/** Candidate bookkeeping only: never publishes notes or creates proposal authority.
 * The trusted selection owner supplies stable fact IDs; model output cannot choose deletion identities.
 * Source revisions and publication receipts require validation by the existing review owner.
 * A candidate labelled lesson is proposed content, never a verified repair outcome.
 */
export namespace MemoryDream {
  export type Candidate = z.input<typeof candidate>
  export type Run = z.infer<typeof run>
  const terminal = new Set<Run["phase"]>(["completed", "cancelled", "failed"])

  function queue<T>(root: string, project: string, body: () => Promise<T>) {
    if (!path.isAbsolute(root) || !path.isAbsolute(project))
      return Promise.reject(new Error("Select owned absolute Dream paths"))
    return MemoryFs.queue(path.resolve(root), body)
  }

  function normalize(input: Candidate) {
    const value = candidate.parse(input)
    const sources = [...value.sources].sort((one, two) => compare(one.path, two.path))
    const changes = [...value.changes].sort((one, two) => compare(one.path, two.path))
    if (
      new Set(sources.map((item) => item.path.toLowerCase())).size !== sources.length ||
      new Set(changes.map((item) => item.path.toLowerCase())).size !== changes.length
    )
      throw new Error("Duplicate Dream source or note target")
    if (changes.some((item) => item.content !== null && !item.content.trim()))
      throw new Error("Dream changes require nonempty Markdown or explicit deletion")
    // Explanation wording is not new evidence and cannot defeat duplicate suppression.
    const fingerprint = createHash("sha256")
      .update(
        canonical({
          fact: value.fact,
          kind: value.kind,
          sources,
          changes,
        }),
      )
      .digest("hex")
    return { fingerprint, candidate: { ...value, sources, changes } }
  }

  async function read(root: string, project: string) {
    if (!path.isAbsolute(root) || !path.isAbsolute(project)) throw new Error("Select owned absolute Dream paths")
    const file = path.join(root, "dream.json")
    const info = await MemoryFs.guard(file)
    if (info && info.size > 3000000) throw new Error("Dream ledger exceeds its review bound")
    const value = schema.parse(
      (await MemoryFs.json(file)) ?? {
        version: 1,
        project: path.resolve(project),
        rows: [],
        tombstones: [],
      },
    )
    if (value.project !== path.resolve(project)) throw new Error("Dream ledger belongs to another project")
    if (
      new Set(value.rows.map((item) => item.fingerprint)).size !== value.rows.length ||
      new Set(value.tombstones).size !== value.tombstones.length ||
      new Set(value.slots.map((item) => item.key)).size !== value.slots.length ||
      new Set(value.slots.map((item) => item.path.toLowerCase())).size !== value.slots.length ||
      (value.slots.length > 0 && !value.scope)
    )
      throw new Error("Duplicate Dream ledger identities")
    if (
      new Set(value.runs.map((item) => item.id)).size !== value.runs.length ||
      value.runs.filter((item) => !terminal.has(item.phase)).length > 1
    )
      throw new Error("Dream run ownership is inconsistent")
    for (const item of value.runs) {
      if (
        item.deadline <= item.started ||
        new Set(item.candidates).size !== item.candidates.length ||
        new Set(item.sources.map((source) => source.path.toLowerCase())).size !== item.sources.length ||
        item.candidates.some((key) => !value.rows.some((row) => row.fingerprint === key))
      )
        throw new Error("Dream selection checkpoint is inconsistent")
    }
    for (const item of value.rows) {
      if (normalize(item.candidate).fingerprint !== item.fingerprint)
        throw new Error("Dream candidate revision changed")
      if (["submitting", "pending", "accepted"].includes(item.state) && !item.proposal)
        throw new Error("Dream submission has no original proposal identity")
      if (item.state === "accepted" && !item.receipt)
        throw new Error("Accepted Dream candidate has no publication receipt")
      const last = item.history.at(-1)!
      if (
        last.state !== item.state ||
        last.proposal !== item.proposal ||
        last.receipt !== item.receipt ||
        last.reason !== item.reason
      )
        throw new Error("Dream disposition history differs from its current revision")
    }
    return value
  }

  async function save(root: string, value: z.infer<typeof schema>) {
    const raw = JSON.stringify(schema.parse(value))
    if (Buffer.byteLength(raw) > 3000000) throw new Error("Dream ledger exceeds its review bound")
    await MemoryFs.write(path.join(root, "dream.json"), raw)
  }

  export function list(root: string, project: string) {
    return queue(root, project, () => read(root, project))
  }

  /** Explicit host-selected slots retain fact identity across runs and authorized note moves. */
  export async function bind(
    root: string,
    project: string,
    input: { key: string; path: string }[],
    signal: AbortSignal,
  ) {
    const slots = schema.shape.slots.unwrap().min(1).max(8).parse(input)
    return queue(root, project, async () => {
      signal.throwIfAborted()
      const value = await read(root, project)
      if (
        value.runs.some((item) => !terminal.has(item.phase)) ||
        value.rows.some((item) => item.state === "submitting")
      )
        throw new Error("Reconcile the original Dream work before changing target slots")
      if (
        new Set(slots.map((item) => item.key)).size !== slots.length ||
        new Set(slots.map((item) => item.path.toLowerCase())).size !== slots.length
      )
        throw new Error("Duplicate Dream target slot")
      for (const slot of slots) {
        if (
          !slot.path.endsWith(".md") ||
          slot.path
            .split("/")
            .some((part) => [".git", "_system", "private", "credentials", "secrets"].includes(part.toLowerCase()))
        )
          throw new Error("Select an ordinary Markdown target slot")
        const existing = value.slots.find((item) => item.key === slot.key)
        if (existing) existing.path = slot.path
        if (!existing) value.slots.push(slot)
      }
      if (new Set(value.slots.map((item) => item.path.toLowerCase())).size !== value.slots.length)
        throw new Error("A Dream note already belongs to another target slot")
      value.scope ??= randomUUID()
      signal.throwIfAborted()
      await save(root, value)
      return { scope: value.scope, slots: slots.map((item) => ({ ...item })) }
    })
  }

  /** Claim a manual run before calling a model. Unresolved runs block replacement after restart. */
  export function begin(
    root: string,
    project: string,
    input: {
      id: string
      owner: string
      model: string
      sources: Run["sources"]
      timeout: number
      budget: Run["budget"]
    },
  ) {
    return queue(root, project, async () => {
      const value = await read(root, project)
      if (value.runs.some((item) => !terminal.has(item.phase)))
        throw new Error("Reconcile the original active Dream run before starting another")
      if (value.rows.some((row) => row.state === "submitting"))
        throw new Error("Reconcile the original uncertain Dream proposal before starting another")
      if (value.runs.some((item) => item.id === input.id)) throw new Error("Dream run identity has already been used")
      const timeout = z.number().int().min(1).max(300000).parse(input.timeout)
      const started = Date.now()
      const selected = run.parse({
        id: input.id,
        owner: input.owner,
        model: input.model,
        sources: input.sources,
        budget: input.budget,
        started,
        deadline: started + timeout,
        candidates: [],
        phase: "generation",
      })
      if (new Set(selected.sources.map((item) => item.path.toLowerCase())).size !== selected.sources.length)
        throw new Error("Duplicate Dream source selection")
      value.runs.push(selected)
      await save(root, value)
      return selected
    })
  }

  /** Advance the retained owner only. Reconciliation can settle existing candidates, never regenerate. */
  export function advance(
    root: string,
    project: string,
    input: {
      id: string
      owner: string
      phase: Run["phase"]
      candidates?: string[]
      reason?: string
    },
  ) {
    return queue(root, project, async () => {
      const next = z
        .object({
          id: z.string().uuid(),
          owner: z.string().uuid(),
          phase: run.shape.phase,
          candidates: z.array(hash).max(20).optional(),
          reason: text.optional(),
        })
        .strict()
        .parse(input)
      const value = await read(root, project)
      const item = value.runs.find((item) => item.id === next.id)
      if (!item || item.owner !== next.owner) throw new Error("Original Dream run owner differs")
      if (terminal.has(item.phase)) throw new Error("Dream run is already terminal")
      const allowed: Record<Run["phase"], Run["phase"][]> = {
        generation: ["validation", "reconciliation", "cancelled", "failed"],
        validation: ["submission", "completed", "reconciliation", "cancelled", "failed"],
        submission: ["review-pending", "reconciliation", "cancelled", "failed"],
        "review-pending": ["completed", "reconciliation", "cancelled", "failed"],
        reconciliation: ["review-pending", "completed", "cancelled", "failed"],
        completed: [],
        cancelled: [],
        failed: [],
      }
      if (!allowed[item.phase].includes(next.phase)) throw new Error("Dream run cannot replay an earlier phase")
      if (["validation", "submission"].includes(next.phase) && Date.now() >= item.deadline)
        throw new Error("Dream generation deadline elapsed; retain cancellation or failure")
      if (next.candidates && (item.phase !== "validation" || next.phase !== "submission"))
        throw new Error("Dream candidate checkpoint can only advance after validation")
      if (next.candidates) {
        if (
          new Set(next.candidates).size !== next.candidates.length ||
          next.candidates.some((key) => !value.rows.some((row) => row.fingerprint === key && row.state === "prepared"))
        )
          throw new Error("Retain the exact prepared candidates before advancing selection")
        item.candidates = next.candidates
      }
      if (next.phase === "submission" && !item.candidates.length)
        throw new Error("Dream submission has no retained candidate checkpoint")
      const rows = value.rows.filter((row) => item.candidates.includes(row.fingerprint))
      if (
        (terminal.has(next.phase) || next.phase === "review-pending") &&
        rows.some((row) => row.state === "submitting")
      )
        throw new Error("Uncertain Dream proposals require original reconciliation")
      if (next.phase === "review-pending" && rows.some((row) => row.state === "prepared"))
        throw new Error("Dream proposals have not been submitted")
      if (next.phase === "completed" && rows.some((row) => ["prepared", "pending"].includes(row.state)))
        throw new Error("Dream review remains pending")
      item.phase = next.phase
      item.reason = next.reason
      await save(root, value)
      return item
    })
  }

  /** Durably retain the whole bounded selection before generation can advance its cursor. */
  export function stage(root: string, project: string, input: readonly Candidate[]) {
    return queue(root, project, async () => {
      if (!input.length || input.length > 20) throw new Error("Select 1–20 Dream candidates")
      const value = await read(root, project)
      const selected = input.map(normalize)
      const fresh = selected.filter(
        (item, index) =>
          !value.tombstones.includes(item.candidate.fact) &&
          !value.rows.some((prior) => prior.fingerprint === item.fingerprint) &&
          selected.findIndex((prior) => prior.fingerprint === item.fingerprint) === index,
      )
      value.rows.push(
        ...fresh.map((item) => ({
          ...item,
          state: "prepared" as const,
          history: [{ state: "prepared" as const, at: Date.now() }],
        })),
      )
      await save(root, value)
      return fresh.map((item) => item.fingerprint)
    })
  }

  /** Persist before calling the existing proposal owner. A submitting row must reconcile, never replay. */
  export function submit(root: string, project: string, fingerprint: string, proposal: string) {
    return queue(root, project, async () => {
      hash.parse(fingerprint)
      z.string().uuid().parse(proposal)
      const value = await read(root, project)
      const item = value.rows.find((item) => item.fingerprint === fingerprint)
      if (!item || item.state !== "prepared" || value.tombstones.includes(item.candidate.fact))
        throw new Error("Dream candidate cannot submit; reconcile its original outcome")
      if (value.rows.some((item) => item.proposal === proposal))
        throw new Error("Proposal identity is already retained")
      item.state = "submitting"
      item.proposal = proposal
      item.history.push({ state: item.state, at: Date.now(), proposal })
      await save(root, value)
    })
  }

  /** Called by the trusted review/reconciliation owner with the exact reviewed candidate revision. */
  export function settle(
    root: string,
    project: string,
    input: {
      fingerprint: string
      state: "pending" | "accepted" | "rejected" | "superseded" | "deleted"
      proposal?: string
      receipt?: string
      reason?: string
    },
  ) {
    return queue(root, project, async () => {
      const next = z
        .object({
          fingerprint: hash,
          state: row.shape.state.exclude(["prepared", "submitting"]),
          proposal: z.string().uuid().optional(),
          receipt: hash.optional(),
          reason: text.optional(),
        })
        .strict()
        .parse(input)
      const value = await read(root, project)
      const item = value.rows.find((item) => item.fingerprint === next.fingerprint)
      if (!item) throw new Error("Dream candidate revision is unavailable")
      const allowed =
        item.state === "prepared"
          ? ["rejected", "superseded", "deleted"]
          : item.state === "submitting"
            ? ["pending", "accepted", "rejected", "superseded", "deleted"]
            : item.state === "pending"
              ? ["accepted", "rejected", "superseded", "deleted"]
              : item.state === "accepted"
                ? ["superseded", "deleted"]
                : ["rejected", "superseded"].includes(item.state)
                  ? ["deleted"]
                  : []
      if (!allowed.includes(next.state))
        throw new Error("Dream disposition is terminal or requires original reconciliation")
      if (item.proposal && next.proposal !== item.proposal) throw new Error("Original Dream proposal identity differs")
      if (next.state === "accepted" && (!next.receipt || !item.proposal))
        throw new Error("Publication receipt and original proposal required")
      if (next.state === "accepted" && value.tombstones.includes(item.candidate.fact))
        throw new Error("Deleted fact cannot be accepted by a later Dream candidate")
      if (next.receipt && next.state !== "accepted") throw new Error("Only publication acceptance may supply a receipt")
      item.state = next.state
      if (next.receipt) item.receipt = next.receipt
      item.reason = next.reason
      item.history.push({
        state: item.state,
        at: Date.now(),
        proposal: item.proposal,
        receipt: item.receipt,
        reason: item.reason,
      })
      if (next.state === "deleted" && !value.tombstones.includes(item.candidate.fact))
        value.tombstones.push(item.candidate.fact)
      await save(root, value)
    })
  }
}
