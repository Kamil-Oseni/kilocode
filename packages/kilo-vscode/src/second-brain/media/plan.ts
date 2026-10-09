import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { canonical, check, document, sha } from "../control/frames"
import { directory, normalize } from "../control/identity"
import { select, verify as selected } from "./selection"
import type { Request } from "./transport"

type Review = {
  format: "raya.media.review.v1"
  generation: string
  selection: Request["selection"]
  files: Awaited<ReturnType<typeof select>>[]
  policySHA: string
  authority: false
  capture_enabled: false
}

const location = z.string().min(1).max(4096).refine(path.isAbsolute, "Explicit absolute media path required")
const input = z
  .object({
    project: location,
    source: location,
    root: location,
    files: z.array(location).min(1).max(16),
    excluded: z.array(location).max(128),
  })
  .strict()

function within(file: string, root: string) {
  const relative = path.relative(normalize(root), normalize(file))
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Match the UTF-8, sorted JSON used by the contained media worker, including non-ASCII paths. */
export function policy(value: unknown) {
  const raw = Buffer.from(JSON.stringify(value))
  const decoded = document(raw, 131072)
  return sha(canonical(decoded.tree, decoded.text))
}

/** Inspect explicit attachments for native review. This proposal grants no import or inference authority. */
export async function prepare(value: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  const cfg = input.parse(value)
  check(
    new Set(cfg.files.map(normalize)).size === cfg.files.length &&
      new Set(cfg.excluded.map(normalize)).size === cfg.excluded.length,
    "Duplicate selected attachments or exclusions",
  )
  for (const root of [cfg.project, cfg.source, cfg.root]) {
    await directory(root)
    signal.throwIfAborted()
  }
  const files = []
  for (const file of cfg.files) {
    check(
      !within(file, cfg.root) && !cfg.excluded.some((root) => within(file, root)),
      "Selected media enters its private library or an excluded root",
    )
    files.push(await select(cfg.source, file))
    signal.throwIfAborted()
  }
  check(new Set(files.map((file) => file.id)).size === files.length, "Duplicate selected media content")
  const selection = {
    format: "raya.media.selection.v1" as const,
    project: cfg.project,
    source: cfg.source,
    root: cfg.root,
    excluded: [...cfg.excluded],
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      kind: file.kind,
      title: path.basename(file.path),
    })),
  }
  const proposal = {
    format: "raya.media.review.v1" as const,
    generation: randomUUID().replaceAll("-", ""),
    selection,
    files,
    policySHA: policy(selection),
    authority: false as const,
    capture_enabled: false as const,
  }
  await verify(proposal, cfg.project, signal)
  return proposal
}

/** Re-check the reviewed originals and exclusion receipts; a proposal is never human consent. */
export async function verify(value: Review, project: string, signal: AbortSignal) {
  signal.throwIfAborted()
  check(
    value.format === "raya.media.review.v1" &&
      value.selection.format === "raya.media.selection.v1" &&
      /^[a-f0-9]{32}$/.test(value.generation) &&
      value.selection.project === project &&
      value.authority === false &&
      value.capture_enabled === false &&
      value.policySHA === policy(value.selection),
    "Media review belongs to another project or changed policy",
  )
  const cfg = input.parse({
    project,
    source: value.selection.source,
    root: value.selection.root,
    files: value.selection.files.map((file) => file.path),
    excluded: value.selection.excluded,
  })
  check(
    value.files.length === cfg.files.length &&
      new Set(cfg.files.map(normalize)).size === cfg.files.length &&
      new Set(cfg.excluded.map(normalize)).size === cfg.excluded.length,
    "Exact distinct reviewed attachment and exclusion inventory required",
  )
  for (const root of [project, cfg.source, cfg.root]) {
    await directory(root)
    signal.throwIfAborted()
  }
  for (const [index, file] of value.files.entries()) {
    check(
      !within(file.path, cfg.root) && !cfg.excluded.some((root) => within(file.path, root)),
      "Reviewed media enters its private library or an excluded root",
    )
    const current = await selected(cfg.source, file)
    signal.throwIfAborted()
    check(
      isDeepStrictEqual(value.selection.files[index], {
        path: current.path,
        sha256: current.sha256,
        bytes: current.bytes,
        kind: current.kind,
        title: path.basename(current.path),
      }),
      "Reviewed media operation differs from its selected original",
    )
  }
  check(new Set(value.files.map((file) => file.id)).size === value.files.length, "Duplicate reviewed media content")
  return value
}
