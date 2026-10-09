import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { check, sha } from "../control/frames"
import { policy, prepare } from "./plan"
import { parse } from "./results"
import type { Request } from "./transport"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const location = z.string().min(1).max(4096).refine(path.isAbsolute)
const kind = z.enum(["image", "audio", "video"])
const bytes = z.number().int().positive().max(33554432)
const span = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).strict()
const base = { kind, sha256: hash, bytes }
const decoded = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("image"),
      width: z.number().int().positive().max(4096),
      height: z.number().int().positive().max(4096),
      segments: z.array(span).length(0),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("audio"),
      duration: z.number().finite().positive().max(60),
      segments: z.array(span).min(1).max(2),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("video"),
      duration: z.number().finite().positive().max(30),
      segments: z.array(span).min(1).max(30),
      audio_streams: z.number().int().min(0).max(1),
    })
    .strict(),
])
const binding = z
  .object({
    id: hash,
    kind,
    origin: location,
    sourceSHA: hash,
    bytes,
    snapshot: z.object({ path: location, sha256: hash, bytes }).strict(),
    decoded,
  })
  .strict()
const candidate = binding
  .extend({
    start: z.number().finite().nonnegative().nullable(),
    end: z.number().finite().positive().nullable(),
    verification: z.literal("uncertain"),
    verifier: z.literal("unavailable"),
    evidence: z.literal("A supervised source evidence verifier is required."),
    authority: z.literal(false),
  })
  .strict()
const result = z
  .object({
    querySHA: hash,
    inventory: z.array(binding).min(1).max(16),
    candidates: z.array(candidate).max(10),
    authority: z.literal(false),
  })
  .strict()

function decodedSpan(value: z.infer<typeof binding>) {
  const info = value.decoded
  check(
    info.kind === value.kind && info.sha256 === value.sourceSHA && info.bytes === value.bytes,
    "Decoded media identity differs",
  )
  if (info.kind === "image") {
    check(info.width * info.height <= 4194304, "Decoded image exceeds its pixel bound")
    return []
  }
  const keys = new Set<string>()
  for (const [index, item] of info.segments.entries()) {
    check(
      item.end > item.start && item.end <= info.duration && (index === 0 || item.start >= info.segments[index - 1].end),
      "Decoded media segments overlap or exceed duration",
    )
    const key = `${item.start}:${item.end}`
    check(!keys.has(key), "Duplicate decoded media segment")
    keys.add(key)
  }
  return info.segments.map((item) => ({ id: value.id, start_ms: item.start * 1000, end_ms: item.end * 1000 }))
}

function snapshot(value: z.infer<typeof binding>, root: string) {
  const suffix = path.extname(value.snapshot.path)
  const allowed = value.kind === "image" ? [".png", ".jpg"] : value.kind === "audio" ? [".wav"] : [".avi", ".mp4"]
  check(
    allowed.includes(suffix) && value.snapshot.path === path.join(root, "Assets", value.id + suffix),
    "Media snapshot escapes its exact immutable content address",
  )
  check(
    value.id === value.sourceSHA && value.snapshot.sha256 === value.sourceSHA && value.snapshot.bytes === value.bytes,
    "Media snapshot differs from its original",
  )
}

function query(request: Request) {
  check(
    request.op === "search" &&
      "query" in request.args &&
      request.args.query.trim() &&
      Buffer.byteLength(request.args.query) <= 2048 &&
      Number.isInteger(request.args.top) &&
      request.args.top >= 1 &&
      request.args.top <= 10,
    "Original bounded media query required",
  )
  return request.args
}

/** Project an already joined original search. This parser grants no filesystem or inference authority. */
export function build(
  review: Awaited<ReturnType<typeof prepare>>,
  request: Request,
  input: unknown,
  pendingSHA: string,
) {
  const terminal = z
    .object({
      format: z.literal("raya.media.terminal.v1"),
      request: z.string(),
      epoch: z.string(),
      release: hash,
      policySHA: hash,
      pendingSHA: hash,
      op: z.literal("search"),
      status: z.literal("completed"),
      accepted: z.literal(true),
      authority: z.literal(false),
      replay: z.literal(false),
      forced: z.literal(false),
      result,
    })
    .passthrough()
    .parse(input)
  const args = query(request)
  check(
    review.format === "raya.media.review.v1" &&
      review.authority === false &&
      review.capture_enabled === false &&
      /^[a-f0-9]{32}$/.test(review.generation) &&
      review.policySHA === policy(review.selection) &&
      isDeepStrictEqual(request.selection, review.selection) &&
      isDeepStrictEqual(
        review.selection.files,
        review.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          bytes: file.bytes,
          kind: file.kind,
          title: path.basename(file.path),
        })),
      ),
    "Media search differs from its frozen review",
  )
  check(
    terminal.request === request.request &&
      terminal.epoch === request.epoch &&
      terminal.release === request.release &&
      terminal.policySHA === request.policySHA &&
      request.policySHA === review.policySHA &&
      terminal.pendingSHA === pendingSHA,
    "Media search terminal differs from its original grant",
  )
  const digest = sha(args.query)
  const held = terminal.result
  check(
    held.querySHA === digest &&
      held.inventory.length === review.files.length &&
      new Set(held.inventory.map((item) => item.id)).size === held.inventory.length &&
      held.candidates.length <= args.top,
    "Media search query or complete inventory differs",
  )
  const segments = held.inventory.flatMap((item) => decodedSpan(item))
  const authorized = review.files.map((file) => {
    const item = held.inventory.find((item) => item.id === file.id)
    check(
      item &&
        item.origin === file.path &&
        item.sourceSHA === file.sha256 &&
        item.bytes === file.bytes &&
        item.kind === file.kind,
      "Media inventory contains an unselected original",
    )
    snapshot(item, review.selection.root)
    return {
      id: file.id,
      path: file.path,
      relative: file.relative,
      sha256: file.sha256,
      bytes: file.bytes,
      snapshot: item.snapshot,
      kind: file.kind,
      duration_ms: item.decoded.kind === "image" ? null : item.decoded.duration * 1000,
    }
  })
  const candidates = held.candidates.map((item) => {
    const { start, end, verification, verifier, evidence, authority, ...original } = item
    const source = held.inventory.find((source) => source.id === item.id)
    check(source && isDeepStrictEqual(source, original), "Media candidate differs from its retained inventory")
    check(
      item.kind === "image"
        ? start === null && end === null
        : start !== null &&
            end !== null &&
            source.decoded.segments.some((segment) => segment.start === start && segment.end === end),
      "Media candidate lacks its exact decoded source span",
    )
    const file = authorized.find((file) => file.id === item.id)!
    return {
      source: { id: file.id, path: file.path, relative: file.relative, sha256: file.sha256, kind: file.kind },
      span: start === null ? null : { start_ms: start * 1000, end_ms: end! * 1000 },
      verdict: verification,
      evidence: [],
      verifier: null,
      provenance:
        "Retrieved candidate from an explicitly selected immutable snapshot; no source evidence verifier is available.",
      query_sha256: digest,
      policy_sha256: review.policySHA,
    }
  })
  const value = parse({
    action: "mediaContext",
    project: review.selection.project,
    selection: {
      root: review.selection.source,
      policy_sha256: review.policySHA,
      release_sha256: request.release,
      generation: review.generation,
      authorized,
    },
    query_sha256: digest,
    candidates,
    truncated: candidates.length === args.top,
    capture_enabled: false,
  })
  return { value, authorized, segments }
}
