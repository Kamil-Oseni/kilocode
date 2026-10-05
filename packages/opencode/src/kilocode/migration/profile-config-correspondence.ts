import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { Intent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { ConfigEvidence, capture } from "./profile-config"
import { assertWorking, origin, type Working } from "./profile-image"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const freeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}
export const transformed = z
  .object({
    kind: z.literal("config-semantic"),
    source: absolute,
    identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict(),
    bytes: z.number().int().safe().nonnegative().max(1048576),
    sourceDigest: digest,
    digest,
    projection: digest,
    graphs: z.array(z.string().uuid()).min(1).max(128),
    excluded: Intent.shape.documents.element.shape.excluded,
    rawBytesPreserved: z.literal(false),
    historicalIntent: z.literal("inert"),
    activation: z.literal("held"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.graphs).size !== value.graphs.length ||
      JSON.stringify(value.graphs) !== JSON.stringify([...value.graphs].sort())
    )
      ctx.addIssue({ code: "custom", message: "Configuration correspondence graphs differ" })
    if (value.excluded.some((entry) => entry.reason === "unsupported" || entry.reason === "invalid-safe-field"))
      ctx.addIssue({ code: "custom", message: "Configuration correspondence contains unsupported fields" })
  })

function select(input: z.output<typeof ConfigEvidence>, file: string) {
  return input.graphs
    .flatMap((graph) =>
      graph.documents
        .filter((document) => key(document.path) === key(file))
        .map((document) => ({ graph: graph.graph, document })),
    )
    .sort((a, b) => a.graph.localeCompare(b.graph))
}

/** Inert archive accounting never authorizes a source reader or accepts historical bytes as current. */
export function validateConfig(raw: z.input<typeof transformed>, input: unknown) {
  const value = transformed.parse(raw)
  const evidence = ConfigEvidence.parse(input)
  const documents = select(evidence, value.source)
  if (
    !documents.length ||
    hash(evidence) !== value.digest ||
    JSON.stringify(documents.map((entry) => entry.graph)) !== JSON.stringify(value.graphs)
  )
    throw new Error("Configuration correspondence component differs")
  for (const { document } of documents)
    if (
      document.identity.dev !== value.identity.dev ||
      document.identity.ino !== value.identity.ino ||
      document.bytes !== value.bytes ||
      document.digest !== value.sourceDigest ||
      JSON.stringify(document.excluded) !== JSON.stringify(value.excluded)
    )
      throw new Error("Configuration correspondence current origin differs")
  if (
    hash(documents.map(({ graph, document }) => ({ graph, safe: document.safe, excluded: document.excluded }))) !==
    value.projection
  )
    throw new Error("Configuration correspondence safe projection differs")
}

const brand: unique symbol = Symbol("held-config-correspondence")
export type ConfigClaim = Readonly<{ [brand]: true }>
const bindings = new WeakMap<object, { token: Working; groups: readonly z.output<typeof transformed>[] }>()

/** Reuse the real held codec verification; caller labels or copied JSON cannot mint a file claim. */
export async function bindConfig(
  token: Working,
  raw: unknown,
  mode: "strict" | "selected" = "strict",
): Promise<ConfigClaim> {
  assertWorking(token)
  const evidence = ConfigEvidence.parse(raw)
  const verified = await capture(token, evidence.graphs)
  if (hash(verified) !== hash(evidence)) throw new Error("Configuration correspondence differs from held capture")
  const groups = [...new Set(evidence.graphs.flatMap((graph) => graph.documents.map((document) => document.path)))]
    .sort()
    .filter(
      (file) =>
        mode !== "selected" ||
        !select(evidence, file).some(({ document }) =>
          document.excluded.some((entry) => entry.reason === "unsupported" || entry.reason === "invalid-safe-field"),
        ),
    )
    .map((file) => {
      const source = origin(token, file)
      const documents = select(evidence, file)
      const value = transformed.parse({
        kind: "config-semantic",
        source: file,
        identity: { dev: source.dev, ino: source.ino },
        bytes: source.bytes,
        sourceDigest: source.digest,
        digest: hash(evidence),
        graphs: documents.map((entry) => entry.graph),
        projection: hash(
          documents.map(({ graph, document }) => ({ graph, safe: document.safe, excluded: document.excluded })),
        ),
        excluded: documents[0].document.excluded,
        rawBytesPreserved: false,
        historicalIntent: "inert",
        activation: "held",
      })
      validateConfig(value, evidence)
      return freeze(value)
    })
  const claim = Object.freeze({ [brand]: true as const })
  assertWorking(token)
  bindings.set(claim, { token, groups: Object.freeze(groups) })
  return claim
}

/** Claims remain usable only in their exact live image; raw source identity is rechecked. */
export function configGroups(token: Working, claim: unknown) {
  assertWorking(token)
  const value = typeof claim === "object" && claim !== null ? bindings.get(claim) : undefined
  if (!value || value.token !== token)
    throw new Error("Configuration correspondence binding is absent or belongs to another image")
  for (const group of value.groups) {
    const source = origin(token, group.source)
    if (
      source.dev !== group.identity.dev ||
      source.ino !== group.identity.ino ||
      source.bytes !== group.bytes ||
      source.digest !== group.sourceDigest
    )
      throw new Error("Configuration correspondence native origin differs")
  }
  return value.groups
}
