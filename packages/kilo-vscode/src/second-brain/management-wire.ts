import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = (size: number) => z.string().min(1).max(size)
export const Candidate = z
  .object({
    id: text(256),
    relative: text(512),
    note_sha256: hash,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    excerpt: text(8192).refine((value) => Buffer.byteLength(value, "utf8") <= 8192),
    excerpt_sha256: hash,
    entry_sha256: hash,
    entry: text(256),
    kind: z.enum(["capture", "managed", "curated"]),
  })
  .strict()
  .refine((value) => value.end > value.start, "Complete entry boundary required")
export type Candidate = z.infer<typeof Candidate>
export const Candidates = z
  .object({ candidates: z.array(Candidate).max(12), truncated: z.boolean(), capture_enabled: z.literal(false) })
  .strict()
  .refine((value) => new Set(value.candidates.map((row) => row.id)).size === value.candidates.length)

export const Proposal = z
  .object({
    format: z.literal("raya.memory.proposal.v1"),
    id: text(256),
    project: text(4096),
    digest: hash,
    status: z.enum(["pending", "cancelled", "applying", "applied"]),
    capture_enabled: z.literal(false),
    sources: z
      .array(
        z.object({
          path: text(4096),
          sha256: hash,
          kind: z.enum(["user_statement", "tool_observation", "document", "assistant_interpretation"]),
          event_time: z.string().nullable(),
        }),
      )
      .min(1)
      .max(12),
    changes: z
      .array(
        z.object({
          path: text(4096),
          expected: hash.nullable(),
          content: z.string().max(262144).nullable(),
          before: z.string().max(262144).nullable(),
        }),
      )
      .min(1)
      .max(12),
    provenance: z.string().max(32768),
  })
  .passthrough()
export type Proposal = z.infer<typeof Proposal>
