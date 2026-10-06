import { createHash } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { MemoryDream } from "./dream"
import { MemoryDream as ledger } from "./dream"
import { MemoryDreamInput } from "./dream-input"
import { MemoryFs } from "./fs"
import { MemoryRedact } from "../capture/redact"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const relative = z
  .string()
  .max(512)
  .refine(
    (value) =>
      Boolean(value) &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => !["", ".", ".."].includes(part)),
  )
const source = z
  .object({ path: z.string().max(32768), sha256: hash, kind: z.literal("document"), event_time: z.null() })
  .strict()
const change = z
  .object({
    path: relative.refine((value) => value.endsWith(".md")),
    expected: hash.nullable(),
    content: z.string().max(250000).nullable(),
  })
  .strict()
const request = z
  .object({
    action: z.literal("propose"),
    project: z.string(),
    id: z.string().uuid(),
    request: z.object({ sources: z.array(source).min(1).max(8), changes: z.array(change).min(1).max(16) }).strict(),
  })
  .strict()
const proposal = z
  .object({
    format: z.literal("raya.memory.proposal.v1"),
    id: z.string().uuid(),
    project: z.string(),
    digest: hash,
    status: z.literal("pending"),
    capture_enabled: z.literal(false),
    sources: z.array(source).min(1).max(8),
    changes: z
      .array(change.extend({ before: z.string().max(250000).nullable() }))
      .min(1)
      .max(16),
    provenance: z.string().min(1).max(8000),
  })
  .strict()

const outcome = proposal.extend({
  status: z.enum(["pending", "cancelled", "applying", "applied"]),
  reviewed_digest: hash.optional(),
  receipt: z
    .object({
      id: z.string().uuid(),
      status: z.literal("committed"),
      duplicate: z.boolean(),
      note_sha256: z.record(relative, hash.nullable()),
    })
    .strict()
    .optional(),
})

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([one], [two]) => Buffer.compare(Buffer.from(one), Buffer.from(two)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

function ordered<T extends { path: string }>(items: readonly T[]): T[] {
  return [...items].sort((one, two) => (one.path < two.path ? -1 : one.path > two.path ? 1 : 0))
}

/** Trusted host supplies its existing proposal owner. Review outcomes never authorize replay. */
export namespace MemoryDreamProposal {
  /** Only the native user edit flow calls this; a model cannot revise review history. */
  export async function revise(root: string, project: string, input: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(input) ?? "") > 3000000) throw new Error("Dream correction exceeds its bound")
    const identity = z.object({ id: z.string().uuid(), project: z.string() }).parse(input)
    if (identity.project !== project) throw new Error("Original Dream correction project differs")
    return MemoryFs.queue(path.resolve(root), async () => {
      const saved = await ledger.list(root, project)
      const row = saved.rows.find((item) => item.proposal === identity.id)
      if (!row) return { status: "untracked" as const }
      const value = proposal.parse(input)
      const { digest, ...proof } = value
      if (createHash("sha256").update(canonical(proof)).digest("hex") !== digest)
        throw new Error("Dream correction digest differs")
      if (
        !isDeepStrictEqual(
          ordered(value.sources),
          ordered(
            row.candidate.sources.map((item) => ({
              path: path.join(project, item.path),
              sha256: item.sha256,
              kind: "document",
              event_time: null,
            })),
          ),
        )
      )
        throw new Error("Dream correction cannot change original evidence")
      for (const item of value.changes)
        if (
          (item.before === null ? null : createHash("sha256").update(item.before).digest("hex")) !== item.expected ||
          (item.content !== null && MemoryRedact.text(item.content) !== item.content)
        )
          throw new Error("Dream correction baseline differs or contains a secret")
      signal.throwIfAborted()
      const fingerprint = await ledger.revise(root, project, value.id, {
        ...row.candidate,
        changes: value.changes.map((item) => ({ path: item.path, expected: item.expected, content: item.content })),
      })
      return { status: "pending" as const, fingerprint }
    })
  }
  /** Reconcile a retained original proposal; this never retries a write or certifies a repair. */
  export async function reconcile(root: string, project: string, input: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(input) ?? "") > 3000000) throw new Error("Dream outcome exceeds its bound")
    const identity = z.object({ id: z.string().uuid(), project: z.string() }).parse(input)
    if (identity.project !== project) throw new Error("Original Dream outcome project differs")
    return MemoryFs.queue(path.resolve(root), async () => {
      signal.throwIfAborted()
      const saved = await ledger.list(root, project)
      const row = saved.rows.find((item) => item.proposal === identity.id)
      if (!row) return { status: "untracked" as const }
      const value = outcome.parse(input)
      const { digest, ...proof } = value
      if (createHash("sha256").update(canonical(proof)).digest("hex") !== digest)
        throw new Error("Dream outcome digest differs")
      const sources = row.candidate.sources.map((item) => ({
        path: path.join(project, item.path),
        sha256: item.sha256,
        kind: "document",
        event_time: null,
      }))
      if (
        !isDeepStrictEqual(ordered(sources), ordered(value.sources)) ||
        !isDeepStrictEqual(
          ordered(row.candidate.changes),
          ordered(value.changes.map((item) => ({ path: item.path, expected: item.expected, content: item.content }))),
        )
      )
        throw new Error("Reviewed Dream candidate changed; retain original reconciliation")
      for (const item of value.changes)
        if ((item.before === null ? null : createHash("sha256").update(item.before).digest("hex")) !== item.expected)
          throw new Error("Dream outcome baseline differs")
      if (value.status === "applying") return { status: "unresolved" as const }
      if (value.status === "pending") {
        if (row.state === "pending") return { status: "pending" as const }
        signal.throwIfAborted()
        await ledger.settle(root, project, { fingerprint: row.fingerprint, proposal: value.id, state: "pending" })
        return { status: "pending" as const }
      }
      if (value.status === "cancelled") {
        if (row.state === "rejected") return { status: "rejected" as const }
        signal.throwIfAborted()
        await ledger.settle(root, project, {
          fingerprint: row.fingerprint,
          proposal: value.id,
          state: "rejected",
          reason: "Original proposal cancelled by its review owner",
        })
        return { status: "rejected" as const }
      }
      const receipt = value.receipt
      if (
        !receipt ||
        receipt.id !== value.id ||
        !value.reviewed_digest ||
        !isDeepStrictEqual(Object.keys(receipt.note_sha256).sort(), value.changes.map((item) => item.path).sort())
      )
        throw new Error("Original Dream publication receipt is unavailable")
      for (const item of value.changes) {
        if ((item.content === null) !== (receipt.note_sha256[item.path] === null))
          throw new Error("Dream publication receipt contradicts the reviewed change")
        const observed = await MemoryDreamInput.baseline(root, item.path, signal)
        if (observed.expected !== receipt.note_sha256[item.path])
          throw new Error("Published Dream note differs from its receipt")
      }
      const fingerprint = createHash("sha256").update(canonical(receipt)).digest("hex")
      const deleted = row.candidate.changes.every((item) => item.content === null)
      if (row.state === "deleted" && row.receipt === fingerprint) return { status: "deleted" as const }
      if (row.state === "accepted" && row.receipt === fingerprint) {
        if (!deleted) return { status: "accepted" as const }
        // Reconcile a receipt saved before deletion suppression was connected, without replay.
        signal.throwIfAborted()
        await ledger.settle(root, project, {
          fingerprint: row.fingerprint,
          proposal: value.id,
          state: "deleted",
          reason: "Original review published deletion of every fact target",
        })
        return { status: "deleted" as const }
      }
      signal.throwIfAborted()
      await ledger.settle(root, project, {
        fingerprint: row.fingerprint,
        proposal: value.id,
        state: "accepted",
        receipt: fingerprint,
      })
      return deleted ? { status: "deleted" as const } : { status: "accepted" as const }
    })
  }
  export async function submit(
    project: string,
    id: string,
    candidate: MemoryDream.Candidate,
    execute: (command: z.infer<typeof request>, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    if (!path.isAbsolute(project)) throw new Error("Select the authorized absolute Dream project")
    const selected = request.parse({
      action: "propose",
      project,
      id,
      request: {
        changes: candidate.changes,
        sources: candidate.sources.map((item) => ({
          path: path.join(project, relative.parse(item.path)),
          sha256: item.sha256,
          kind: "document",
          event_time: null,
        })),
      },
    })
    if (
      new Set(selected.request.sources.map((item) => item.path.toLowerCase())).size !==
        selected.request.sources.length ||
      new Set(selected.request.changes.map((item) => item.path.toLowerCase())).size !==
        selected.request.changes.length ||
      Buffer.byteLength(JSON.stringify(selected)) > 2000000
    )
      throw new Error("Dream proposal selection is duplicate or exceeds its bound")
    // The ledger has retained this ID before submission. Never replay after an unknown reply.
    const value = await execute(structuredClone(selected), signal)
    signal.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > 3000000)
      throw new Error("Dream proposal reply exceeds its bound")
    const reply = proposal.parse(value)
    if (
      reply.id !== selected.id ||
      reply.project !== selected.project ||
      !isDeepStrictEqual(ordered(reply.sources), ordered(selected.request.sources)) ||
      reply.changes.length !== selected.request.changes.length
    )
      throw new Error("Original Dream proposal reply differs")
    for (const [index, item] of ordered(reply.changes).entries()) {
      const { before, ...actual } = item
      if (
        !isDeepStrictEqual(actual, ordered(selected.request.changes)[index]) ||
        (before === null ? null : createHash("sha256").update(before).digest("hex")) !== item.expected
      )
        throw new Error("Original Dream proposal changes or baseline differ")
    }
    return { id: reply.id, status: reply.status }
  }
}
