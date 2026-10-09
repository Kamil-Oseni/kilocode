import path from "node:path"
import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { check, sha } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { select, verify as selected } from "./selection"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const location = z.string().min(1).max(4096)
const kind = z.enum(["image", "audio", "video"])
const span = z
  .object({ start_ms: z.number().finite().min(0).max(86400000), end_ms: z.number().finite().positive().max(86400000) })
  .strict()
  .refine((value) => value.end_ms > value.start_ms, "Media span must advance")
const verifier = z.object({ id: z.string().min(1).max(256), sha256: hash }).strict()
const snapshot = z.object({ path: location, sha256: hash, bytes: z.number().int().positive().max(33554432) }).strict()
const authorized = z
  .object({
    id: hash,
    path: location,
    relative: location,
    sha256: hash,
    bytes: z.number().int().positive().max(33554432),
    snapshot,
    kind,
    duration_ms: z.number().finite().positive().max(86400000).nullable(),
  })
  .strict()
const candidate = z
  .object({
    source: z.object({ id: hash, path: location, relative: location, sha256: hash, kind }).strict(),
    span: span.nullable(),
    verdict: z.enum(["supported", "rejected", "uncertain"]),
    evidence: z
      .array(z.object({ text: z.string().min(1).max(16000), sha256: hash, span: span.nullable() }).strict())
      .max(8),
    verifier: verifier.nullable(),
    provenance: z.string().min(1).max(4096),
    query_sha256: hash,
    policy_sha256: hash,
  })
  .strict()
const result = z
  .object({
    action: z.literal("mediaContext"),
    project: location,
    selection: z
      .object({
        root: location,
        policy_sha256: hash,
        release_sha256: hash,
        generation: z.string().regex(/^[a-f0-9]{32}$/),
        authorized: z.array(authorized).min(1).max(16),
      })
      .strict(),
    query_sha256: hash,
    candidates: z.array(candidate).max(10),
    truncated: z.boolean(),
    capture_enabled: z.literal(false),
  })
  .strict()

/** Parse typed outcomes; a retrieval rank never grants verifier support. */
export function parse(input: unknown) {
  const value = result.parse(input)
  check(
    new Set(
      value.candidates.map(
        (item) => `${item.source.id}:${item.span?.start_ms ?? "image"}:${item.span?.end_ms ?? "image"}`,
      ),
    ).size === value.candidates.length,
    "Duplicate media candidate source spans",
  )
  check(
    new Set(value.selection.authorized.map((item) => item.id)).size === value.selection.authorized.length,
    "Duplicate selected media content IDs",
  )
  for (const item of value.selection.authorized) {
    check(
      item.id === item.sha256 && item.snapshot.sha256 === item.sha256 && item.snapshot.bytes === item.bytes,
      "Media immutable snapshot differs from its selected original",
    )
    check(
      item.kind === "image" ? item.duration_ms === null : item.duration_ms !== null,
      "Decoded media duration required",
    )
  }
  for (const item of value.candidates) {
    const source = value.selection.authorized.find((source) => source.id === item.source.id)
    check(
      source &&
        isDeepStrictEqual(item.source, {
          id: source.id,
          path: source.path,
          relative: source.relative,
          sha256: source.sha256,
          kind: source.kind,
        }) &&
        item.query_sha256 === value.query_sha256 &&
        item.policy_sha256 === value.selection.policy_sha256,
      "Media candidate provenance or query binding differs",
    )
    check(
      source.kind === "image" ? item.span === null : item.span !== null && item.span.end_ms <= source.duration_ms!,
      "Media candidate exceeds its decoded source",
    )
    check(
      item.verdict !== "supported" || (item.verifier !== null && item.evidence.length > 0),
      "Supported media requires verifier evidence",
    )
    for (const evidence of item.evidence) {
      check(evidence.sha256 === sha(evidence.text), "Media evidence text digest differs")
      check(
        evidence.text.trim() && isDeepStrictEqual(evidence.span, item.span),
        "Media evidence exceeds its candidate span",
      )
    }
  }
  return value
}

type Options = {
  project: string
  root: string
  querySHA: string
  policySHA: string
  releaseSHA: string
  generation: string
  selected: readonly Awaited<ReturnType<typeof select>>[]
  authorized: readonly z.infer<typeof authorized>[]
  forgotten: readonly string[]
  library: string
  verifiers?: readonly z.infer<typeof verifier>[]
  segments?: readonly { id: string; start_ms: number; end_ms: number }[]
}

function range(item: z.infer<typeof candidate>, opts: Options) {
  if (item.span === null) return
  check(
    opts.segments?.some(
      (segment) =>
        segment.id === item.source.id &&
        Number.isFinite(segment.start_ms) &&
        Number.isFinite(segment.end_ms) &&
        segment.start_ms >= 0 &&
        segment.end_ms > segment.start_ms &&
        item.span!.start_ms >= segment.start_ms &&
        item.span!.end_ms <= segment.end_ms,
    ),
    "Media span lacks its actual decoded candidate range",
  )
}

async function original(source: z.infer<typeof authorized>, opts: Options) {
  check(!opts.forgotten.includes(source.id), "Forgotten media source cannot be consumed")
  const value = opts.selected.find((item) => item.id === source.id)
  check(
    value &&
      value.path === source.path &&
      value.relative === source.relative &&
      value.sha256 === source.sha256 &&
      value.bytes === source.bytes &&
      value.kind === source.kind,
    "Media source was not explicitly authorized",
  )
  await selected(opts.root, value)
}

/** Revalidate original approved sources and immutable snapshots immediately before conversation consumption. */
export async function verify(input: unknown, opts: Options) {
  const value = parse(input)
  check(
    value.project === opts.project &&
      value.selection.root === opts.root &&
      value.query_sha256 === opts.querySHA &&
      value.selection.policy_sha256 === opts.policySHA &&
      value.selection.release_sha256 === opts.releaseSHA &&
      value.selection.generation === opts.generation,
    "Media result belongs to a stale or different authorized query",
  )
  check(
    opts.selected.length <= 16 &&
      value.selection.authorized.length === opts.selected.length &&
      isDeepStrictEqual(value.selection.authorized, opts.authorized),
    "Exact authorized media selection required",
  )
  await directory(opts.library)
  for (const source of value.selection.authorized) {
    await original(source, opts)
    const relative = path.relative(opts.library, source.snapshot.path)
    check(
      path.isAbsolute(source.snapshot.path) &&
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        normalize(path.join(opts.library, relative)) === normalize(source.snapshot.path),
      "Media snapshot escapes its immutable library",
    )
    await directory(path.dirname(source.snapshot.path))
    const held = await image(source.snapshot.path, 33554432)
    check(
      held.digest === source.snapshot.sha256 && held.raw.length === source.snapshot.bytes,
      "Immutable media library snapshot changed",
    )
  }
  for (const item of value.candidates) {
    check(
      item.verdict !== "supported" || opts.verifiers?.some((approved) => isDeepStrictEqual(approved, item.verifier)),
      "Media verifier is not part of the selected verified release",
    )
    range(item, opts)
  }
  return value
}
