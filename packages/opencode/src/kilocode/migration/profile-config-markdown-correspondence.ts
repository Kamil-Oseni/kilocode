import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { MarkdownOrigin, Projection, markdownDigest } from "@opencode-ai/core/kilocode/config-markdown-schema"
import { ConfigEvidence, requireConfigCapture } from "./profile-config"
import { assertWorking, origin, type Working } from "./profile-image"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))
const binding = z
  .object({
    graph: z.string().uuid(),
    kind: MarkdownOrigin.shape.kind,
    name: MarkdownOrigin.shape.name,
    order: MarkdownOrigin.shape.order,
    trusted: MarkdownOrigin.shape.trusted,
  })
  .strict()
export const configMarkdown = z
  .object({
    kind: z.literal("config-markdown"),
    source: MarkdownOrigin.shape.path,
    identity: MarkdownOrigin.shape.identity,
    bytes: MarkdownOrigin.shape.bytes,
    sourceDigest: digest,
    digest,
    projection: digest,
    bindings: z.array(binding).min(1).max(4096),
    excluded: Projection.shape.excluded,
    rawBytesPreserved: z.literal(false),
    historicalIntent: z.literal("inert"),
    activation: z.literal("held"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const graphs = value.bindings.map((entry) => entry.graph + ":" + entry.order)
    const sorted = [...value.bindings].sort((a, b) => a.graph.localeCompare(b.graph) || a.order - b.order)
    if (new Set(graphs).size !== graphs.length || JSON.stringify(value.bindings) !== JSON.stringify(sorted))
      ctx.addIssue({ code: "custom", message: "Markdown correspondence graph order differs" })
    if (value.excluded.some((entry) => entry.reason === "unsupported" || entry.reason === "invalid-safe-field"))
      ctx.addIssue({ code: "custom", message: "Markdown correspondence contains unsupported projection" })
  })
function select(evidence: z.output<typeof ConfigEvidence>, file: string) {
  if (evidence.version === 1) return []
  return evidence.graphs
    .flatMap((graph) =>
      // History is inert component evidence. It cannot substitute for a current
      // native origin or contribute an additional physical-file claim.
      graph.markdown
        .filter((document) => key(document.path) === key(file))
        .map((document) => {
          const values = evidence.markdown.filter(
            (entry) => entry.graph === graph.graph && key(entry.path) === key(file),
          )
          if (!values.length || values.some((entry) => markdownDigest(entry.value) !== document.projection))
            throw new Error("Markdown correspondence current projection is ambiguous")
          return { graph: graph.graph, document, value: values[0].value }
        }),
    )
    .sort((a, b) => a.graph.localeCompare(b.graph) || a.document.order - b.document.order)
}
const identities = (entries: ReturnType<typeof select>) =>
  entries.map((entry) => ({
    graph: entry.graph,
    kind: entry.document.kind,
    name: entry.document.name,
    order: entry.document.order,
    trusted: entry.document.trusted,
  }))
const projection = (entries: ReturnType<typeof select>) =>
  hash(
    entries.map((entry) => ({
      binding: identities([entry])[0],
      value: entry.value,
    })),
  )
/** Serialized claims account for inert projections; they never authorize a source reader. */
export function validateMarkdown(raw: z.input<typeof configMarkdown>, input: unknown) {
  const entry = configMarkdown.parse(raw),
    evidence = ConfigEvidence.parse(input)
  const entries = select(evidence, entry.source)
  if (
    !entries.length ||
    hash(evidence) !== entry.digest ||
    JSON.stringify(identities(entries)) !== JSON.stringify(entry.bindings)
  )
    throw new Error("Markdown correspondence component or loader binding differs")
  for (const item of entries)
    if (
      item.document.identity.dev !== entry.identity.dev ||
      item.document.identity.ino !== entry.identity.ino ||
      item.document.bytes !== entry.bytes ||
      item.document.digest !== entry.sourceDigest ||
      item.document.projection !== markdownDigest(item.value) ||
      JSON.stringify(item.value.excluded) !== JSON.stringify(entry.excluded)
    )
      throw new Error("Markdown correspondence current origin differs")
  if (projection(entries) !== entry.projection) throw new Error("Markdown correspondence safe projection differs")
}
const brand: unique symbol = Symbol("held-markdown-correspondence")
export type MarkdownClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly z.output<typeof configMarkdown>[] }>()
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
/** Only the exact current held capture object supplies loader/projection provenance. */
export function bindMarkdown(token: Working, proof: unknown): MarkdownClaim {
  const evidence = requireConfigCapture(token, proof)
  const files = evidence.version === 1 ? [] : [...new Set(evidence.markdown.map((entry) => entry.path))].sort()
  const groups = files.flatMap((file) => {
    const entries = select(evidence, file)
    if (
      entries.some((item) =>
        item.value.excluded.some((field) => field.reason === "unsupported" || field.reason === "invalid-safe-field"),
      )
    )
      return []
    const native = origin(token, file)
    const entry = configMarkdown.parse({
      kind: "config-markdown",
      source: file,
      identity: { dev: native.dev, ino: native.ino },
      bytes: native.bytes,
      sourceDigest: native.digest,
      digest: hash(evidence),
      projection: projection(entries),
      bindings: identities(entries),
      excluded: entries[0].value.excluded,
      rawBytesPreserved: false,
      historicalIntent: "inert",
      activation: "held",
    })
    validateMarkdown(entry, evidence)
    return [freeze(entry)]
  })
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: Object.freeze(groups) })
  return claim
}
export function markdownGroups(token: Working, proof: unknown) {
  assertWorking(token)
  const state = proof && typeof proof === "object" ? claims.get(proof) : undefined
  if (!state || state.token !== token)
    throw new Error("Markdown correspondence binding is absent or belongs to another image")
  for (const entry of state.groups) {
    const native = origin(token, entry.source)
    if (
      native.dev !== entry.identity.dev ||
      native.ino !== entry.identity.ino ||
      native.bytes !== entry.bytes ||
      native.digest !== entry.sourceDigest
    )
      throw new Error("Markdown correspondence native origin differs")
  }
  return state.groups
}
