import { createHash } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { MemoryDream } from "./dream"

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

/** Trusted host supplies its existing proposal owner. This adapter creates pending review only. */
export namespace MemoryDreamProposal {
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
      !isDeepStrictEqual(reply.sources, selected.request.sources) ||
      reply.changes.length !== selected.request.changes.length
    )
      throw new Error("Original Dream proposal reply differs")
    for (const [index, item] of reply.changes.entries()) {
      const { before, ...actual } = item
      if (
        !isDeepStrictEqual(actual, selected.request.changes[index]) ||
        (before === null ? null : createHash("sha256").update(before).digest("hex")) !== item.expected
      )
        throw new Error("Original Dream proposal changes or baseline differ")
    }
    return { id: reply.id, status: reply.status }
  }
}
