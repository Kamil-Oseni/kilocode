import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Intent, LineageIntent, MarkdownIntent, project } from "@opencode-ai/core/kilocode/config-intent-schema"
import { Projection, projectMarkdown, markdownDigest } from "@opencode-ai/core/kilocode/config-markdown-schema"
import { assertWorking, lookup, origin, type Working } from "./profile-image"

const legacy = z
  .object({
    format: z.literal("raya.config-review"),
    version: z.literal(1),
    graphs: z.array(Intent).max(128),
    reviewOnly: z.literal(true),
    activation: z.literal("held"),
    coverage: z.literal("loaded-json-config-only"),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
const review = legacy
  .extend({
    version: z.literal(2),
    graphs: z.array(MarkdownIntent).max(128),
    markdown: z
      .array(z.object({ graph: z.string().uuid(), path: z.string().max(4096), value: Projection }).strict())
      .max(4096),
    coverage: z.literal("loaded-json-and-markdown-config-only"),
  })
  .strict()
const lineage = review.extend({ version: z.literal(3), graphs: z.array(LineageIntent).max(128) }).strict()
export const ConfigEvidence = z.union([
  legacy,
  z.union([review, lineage]).superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Markdown review bytes exceed bounds" })
    const expected = value.graphs.flatMap((graph) => graph.markdown.map((item) => ({ graph: graph.graph, item })))
    if (expected.length !== value.markdown.length)
      ctx.addIssue({ code: "custom", message: "Markdown review origins differ" })
    for (const [index, entry] of value.markdown.entries()) {
      const source = expected[index]
      if (
        !source ||
        source.graph !== entry.graph ||
        source.item.path !== entry.path ||
        source.item.projection !== markdownDigest(entry.value)
      )
        ctx.addIssue({ code: "custom", message: "Markdown review projection differs" })
    }
  }),
])
const captures = new WeakMap<object, Working>()
/** Current capture provenance never survives serialization or the native image lifetime. */
export function requireConfigCapture(token: Working, evidence: unknown) {
  assertWorking(token)
  if (!evidence || typeof evidence !== "object" || captures.get(evidence) !== token)
    throw new Error("Configuration capture provenance is absent or belongs to another image")
  return ConfigEvidence.parse(evidence)
}
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

/** Read only exact declared files inside this actual held image; source config never becomes active output. */
export async function capture(
  token: Working,
  configs: readonly z.output<typeof Intent | typeof MarkdownIntent | typeof LineageIntent>[],
) {
  const selected = z
    .array(z.union([MarkdownIntent, LineageIntent]))
    .max(128)
    .parse(configs)
  if (Buffer.byteLength(JSON.stringify(selected)) > 128 * 1024)
    throw new Error("Configuration review metadata exceeds bounds")
  const image = assertWorking(token)
  const markdown: { graph: string; path: string; value: z.output<typeof Projection> }[] = []
  for (const graph of selected) {
    if (
      !image.namespaces.some(
        (item) =>
          key(item.original.data) === key(graph.roots.data) &&
          key(item.original.config) === key(graph.roots.config) &&
          key(item.original.state) === key(graph.roots.state),
      )
    )
      throw new Error("Configuration review lacks its authenticated Global image tuple")
    // Historical descriptors stay in the signed component but never select another
    // source object or projection. Only this current origin may bind the live image.
    for (const document of [...graph.documents, ...graph.markdown]) {
      assertWorking(token)
      const source = origin(token, document.path)
      if (
        source.dev !== document.identity.dev ||
        source.ino !== document.identity.ino ||
        source.bytes !== document.bytes ||
        source.digest !== document.digest
      )
        throw new Error("Configuration held source object differs from acknowledged origin")
      const file = lookup(token, document.path, "json")
      if (!path.isAbsolute(file)) throw new Error("Configuration review staged path is invalid")
      const before = await lstat(file, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(document.bytes))
        throw new Error("Configuration staged origin differs from acknowledged size")
      const bytes = await readFile(file)
      const after = await lstat(file, { bigint: true })
      assertWorking(token)
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink !== 1n ||
        after.size !== before.size ||
        bytes.length !== document.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== document.digest
      )
        throw new Error("Configuration staged bytes differ from acknowledged origin")
      if ("projection" in document) {
        const value = projectMarkdown(bytes.toString("utf8"))
        if (markdownDigest(value) !== document.projection)
          throw new Error("Markdown staged projection differs from acknowledged safe intent")
        markdown.push({ graph: graph.graph, path: document.path, value })
        continue
      }
      const safe = project(bytes.toString("utf8"))
      if (
        JSON.stringify(safe.safe) !== JSON.stringify(document.safe) ||
        JSON.stringify(safe.excluded) !== JSON.stringify(document.excluded)
      )
        throw new Error("Configuration staged projection differs from acknowledged safe intent")
    }
  }
  const evidence = freeze(
    ConfigEvidence.parse({
      format: "raya.config-review",
      version: selected.some((graph) => graph.version === 3) ? 3 : 2,
      graphs: selected,
      markdown,
      reviewOnly: true,
      activation: "held",
      coverage: "loaded-json-and-markdown-config-only",
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    }),
  )
  captures.set(evidence, token)
  return evidence
}
