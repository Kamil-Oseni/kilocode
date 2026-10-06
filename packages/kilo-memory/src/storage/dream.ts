import { createHash } from "node:crypto"
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
const schema = z
  .object({
    version: z.literal(1),
    project: z.string().min(1),
    rows: z.array(row).max(128),
    tombstones: z.array(hash).max(128),
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
      new Set(value.tombstones).size !== value.tombstones.length
    )
      throw new Error("Duplicate Dream ledger identities")
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
