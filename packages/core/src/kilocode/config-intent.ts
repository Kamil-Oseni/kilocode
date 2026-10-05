import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { covers, validatePolicy, type SourcePolicy } from "./source-policy"

import { Intent, LineageIntent, project } from "./config-intent-schema"
import { MarkdownOrigin, MarkdownLineageOrigin, markdownDigest, projectMarkdown } from "./config-markdown-schema"
import { inspect, binding, publication, publish, type Publication, type Predecessor } from "./markdown-publication"
import { resolveProfileRoot } from "./profile-maintenance"
import { registerProcessProfile } from "./process-profile"
export { Intent, project } from "./config-intent-schema"
const absolute = Intent.shape.documents.element.shape.path
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const sum = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}
const sides = new WeakMap<object, readonly z.output<typeof Intent>["documents"][number][]>()
const pins = new WeakMap<object, { dev: bigint; ino: bigint }>()
const revisions = new WeakMap<object, z.output<typeof LineageIntent>["documents"][number]>()
const markdownRevisions = new WeakMap<object, z.output<typeof MarkdownLineageOrigin>>()
const reservations = new Map<string, object>()
const uncertain = new Map<string, NonNullable<ReturnType<typeof binding>>>()
const failures: unknown[] = []
export type Graph = Readonly<{ id: string }>
const markdown = new WeakMap<object, { graph: Graph; file: string; text: string; dev: bigint; ino: bigint }>()
const graphs = new Map<
  Graph,
  {
    parser: "v1" | "v2"
    roots: z.output<typeof Intent>["roots"]
    directory?: string
    documents: readonly z.output<typeof Intent>["documents"][number][]
    markdown: z.output<typeof MarkdownOrigin>[]
    failures: unknown[]
  }
>()
const pending = new Set<Promise<void>>()
let closing: Promise<void> | undefined
export class ConfigIntentRefusal extends Error {
  constructor(readonly code: "origin-uncertain" | "unsupported-fields" | "metadata-overflow") {
    super(`Configuration source intent refused: ${code}`)
  }
}

/** A graph comes only from the caller's already realized config loader; no Global or runtime is initialized. */
export function graph(parser: "v1" | "v2", roots: z.output<typeof Intent>["roots"], directory?: string): Graph {
  if (closing) throw new Error("Configuration origin intake is terminal")
  const token = Object.freeze({ id: randomUUID() })
  graphs.set(token, {
    parser,
    roots: Intent.shape.roots.parse({
      data: path.normalize(roots.data),
      config: path.normalize(roots.config),
      state: path.normalize(roots.state),
    }),
    directory: directory ? absolute.parse(path.normalize(directory)) : undefined,
    documents: [],
    markdown: [],
    failures: [],
  })
  return token
}

/** Called after the actual parser accepts the original bytes, before expansion can become portable evidence. */
export function loaded(token: Graph, object: object, file: string, text: string): Promise<void> {
  const state = graphs.get(token)
  if (!state) throw new Error("Configuration intent graph is unknown")
  if (closing) {
    state.failures.push(new Error("Configuration origin intake is terminal"))
    return Promise.resolve()
  }
  // The successful parser selected this root before asynchronous revalidation.
  // Its cooperative lifetime admission precedes the retirement cutoff.
  try {
    registerProcessProfile([file])
  } catch (err) {
    state.failures.push(err)
    return Promise.resolve()
  }
  const task = (async () => {
    try {
      absolute.parse(file)
      const actual = await realpath(file)
      const info = await lstat(file, { bigint: true })
      const bytes = await readFile(file)
      if (
        key(actual) !== key(file) ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        !bytes.equals(Buffer.from(text))
      )
        throw new Error("Loaded configuration physical origin changed")
      const value = freeze(
        Intent.shape.documents.element.parse({
          path: actual,
          digest: sum(bytes),
          bytes: bytes.length,
          identity: { dev: info.dev.toString(), ino: info.ino.toString() },
          ...project(text),
        }),
      )
      pins.set(value, { dev: info.dev, ino: info.ino })
      sides.set(object, Object.freeze([value]))
    } catch (err) {
      // Ordinary loading remains compatible; capture must retain and refuse this uncertainty.
      state.failures.push(err)
    }
  })()
  pending.add(task)
  void task.then(() => pending.delete(task))
  return task
}

/** Fence new origin intake synchronously, then join already admitted physical reads. */
export function retire(): Promise<void> {
  return (closing ??= Promise.all(pending).then(() => undefined))
}

/** Reserve before the service's actual write; arbitrary later file changes never replace evidence. */
export function writing(file: string, before: string, after: string, opts?: { atomic: true; mode?: number }) {
  if (closing) return Promise.reject(new Error("Configuration origin intake is terminal"))
  registerProcessProfile([file])
  const state = { settled: false, release: () => undefined as void }
  const joined = new Promise<void>((resolve) => {
    state.release = resolve
  })
  pending.add(joined)
  void joined.then(() => pending.delete(joined))
  const finish = (err?: unknown) => {
    if (state.settled) return
    state.settled = true
    if (err !== undefined) failures.push(err)
    state.release()
  }
  const read = async (text: string) => {
    absolute.parse(file)
    const first = await lstat(file, { bigint: true })
    if (!first.isFile() || first.isSymbolicLink() || first.nlink !== 1n)
      throw new Error("Configuration own write physical binding differs")
    const bytes = await readFile(file)
    const last = await lstat(file, { bigint: true })
    if (
      key(await realpath(file)) !== key(file) ||
      !first.isFile() ||
      first.isSymbolicLink() ||
      first.nlink !== 1n ||
      last.dev !== first.dev ||
      last.ino !== first.ino ||
      last.size !== first.size ||
      last.nlink !== 1n ||
      !bytes.equals(Buffer.from(text))
    )
      throw new Error("Configuration own write physical binding differs")
    return {
      first,
      value: Intent.shape.documents.element.parse({
        path: file,
        digest: sum(bytes),
        bytes: bytes.length,
        identity: { dev: first.dev.toString(), ino: first.ino.toString() },
        ...project(text),
      }),
    }
  }
  const initial = read(before)
    .then((original) => {
      for (const graph of graphs.values())
        for (const source of graph.documents) {
          const previous = LineageIntent.shape.documents.element.parse(revisions.get(source) ?? source)
          if (key(previous.path) !== key(file)) continue
          if (
            previous.digest !== original.value.digest ||
            previous.bytes !== original.value.bytes ||
            previous.identity.dev !== original.value.identity.dev ||
            previous.identity.ino !== original.value.identity.ino
          )
            throw new Error("Configuration own write lacks its preceding loaded origin")
        }
      return original
    })
    .catch((err: unknown) => {
      if (
        before === "{}" &&
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "ENOENT" &&
        ![...graphs.values()].some((graph) => graph.documents.some((document) => key(document.path) === key(file)))
      )
        return undefined
      throw err
    })
  return initial
    .then(
      async (original) => {
        const predecessor = opts?.atomic ? await inspect(file) : undefined
        if (predecessor) {
          const value = binding(predecessor)
          if (
            JSON.stringify(value) !==
            JSON.stringify(
              original?.value && {
                path: original.value.path,
                digest: original.value.digest,
                bytes: original.value.bytes,
                identity: original.value.identity,
              },
            )
          )
            throw new Error("Configuration atomic predecessor changed during preparation")
        }
        return {
          fail: finish,
          async publish() {
            if (state.settled || !predecessor) throw new Error("Configuration atomic publication is not prepared")
            return publish(file, after, predecessor, opts?.mode)
          },
          async complete(receipt?: Publication) {
            if (state.settled) throw new Error("Configuration own write is already settled")
            try {
              const current = await read(after)
              if (predecessor) {
                if (!receipt) throw new Error("Configuration atomic publication receipt is missing")
                const value = publication(receipt)
                if (
                  value.predecessor !== predecessor ||
                  JSON.stringify(value.before) !== JSON.stringify(binding(predecessor)) ||
                  value.after.path !== file ||
                  value.after.digest !== current.value.digest ||
                  value.after.bytes !== current.value.bytes ||
                  value.after.identity.dev !== current.value.identity.dev ||
                  value.after.identity.ino !== current.value.identity.ino
                )
                  throw new Error("Configuration atomic publication receipt differs")
              } else {
                if (receipt) throw new Error("Configuration ordinary write cannot accept an atomic receipt")
                if (original && (current.first.dev !== original.first.dev || current.first.ino !== original.first.ino))
                  throw new Error("Configuration own write replaced physical identity")
              }
              const sources = new Set([...graphs.values()].flatMap((graph) => graph.documents))
              const updates = [...sources].flatMap((source) => {
                const previous = LineageIntent.shape.documents.element.parse(revisions.get(source) ?? source)
                if (key(previous.path) !== key(file)) return []
                if (!original) throw new Error("Configuration own write lacks its preceding loaded origin")
                if (
                  previous.digest !== original.value.digest ||
                  previous.bytes !== original.value.bytes ||
                  previous.identity.dev !== original.value.identity.dev ||
                  previous.identity.ino !== original.value.identity.ino
                )
                  throw new Error("Configuration own write lacks its preceding loaded origin")
                const history = [...(previous.history ?? []), Intent.shape.documents.element.strip().parse(previous)]
                const next = freeze(LineageIntent.shape.documents.element.parse({ ...current.value, history }))
                return [{ source, next }]
              })
              for (const update of updates) revisions.set(update.source, update.next)
              finish()
            } catch (err) {
              finish(err)
              throw err
            }
          },
        }
      },
      (err: unknown) => {
        finish(err)
        throw err
      },
    )
    .catch((err: unknown) => {
      finish(err)
      throw err
    })
}

/** Reserve accepted Markdown publication before its writer performs asynchronous admission. */
export function reserveMarkdown(file: string) {
  if (closing) throw new Error("Configuration origin intake is terminal")
  absolute.parse(file)
  const token = Object.freeze({})
  const selected = key(file)
  if (reservations.has(selected)) throw new Error("Markdown own write is already reserved")
  reservations.set(selected, token)
  const joined = Promise.withResolvers<void>()
  pending.add(joined.promise)
  void joined.promise.then(() => pending.delete(joined.promise))
  const state: { settled: boolean; predecessor?: Predecessor; path?: string; prepared: boolean } = {
    settled: false,
    prepared: false,
  }
  function finish(err?: unknown) {
    if (state.settled) return
    state.settled = true
    if (err !== undefined) failures.push(err)
    for (const [file, owner] of reservations) if (owner === token) reservations.delete(file)
    joined.resolve()
  }
  function matches(origin: z.output<typeof MarkdownOrigin>, value: ReturnType<typeof binding>) {
    return (
      !!value &&
      key(origin.path) === key(value.path) &&
      origin.digest === value.digest &&
      origin.bytes === value.bytes &&
      origin.identity.dev === value.identity.dev &&
      origin.identity.ino === value.identity.ino
    )
  }
  return Object.freeze({
    fail: finish,
    async prepare(target = file) {
      if (state.settled || state.prepared) throw new Error("Markdown own write preparation is already settled")
      state.prepared = true
      try {
        const root = await resolveProfileRoot({ kind: "json", path: file })
        if (key(root.path) !== key(target)) throw new Error("Markdown own write canonical target differs")
        const owner = reservations.get(key(target))
        if (owner && owner !== token) throw new Error("Markdown own write canonical target is already reserved")
        reservations.set(key(target), token)
        registerProcessProfile([target])
        const before = await inspect(target)
        const value = binding(before)
        for (const graph of graphs.values())
          for (const origin of graph.markdown) {
            const current = markdownRevisions.get(origin) ?? origin
            if (key(current.path) === key(target) && !matches(current, value)) {
              const retained = uncertain.get(key(target))
              if (!retained || JSON.stringify(retained) !== JSON.stringify(value))
                throw new Error("Markdown own write lacks its preceding loaded origin")
            }
          }
        state.path = target
        state.predecessor = before
        return before
      } catch (err) {
        finish(err)
        throw err
      }
    },
    async complete(receipt: Publication) {
      if (state.settled || !state.predecessor || !state.path) throw new Error("Markdown own write is not prepared")
      try {
        const value = publication(receipt)
        if (
          value.predecessor !== state.predecessor ||
          key(value.after.path) !== key(state.path) ||
          JSON.stringify(value.before) !== JSON.stringify(binding(state.predecessor))
        )
          throw new Error("Markdown own write publication differs from its predecessor")
        const actual = binding(await inspect(state.path))
        if (JSON.stringify(actual) !== JSON.stringify(value.after))
          throw new Error("Markdown own write final publication changed")
        if (uncertain.has(key(state.path))) {
          uncertain.set(key(state.path), value.after)
          finish()
          return
        }
        const updates: { source: object; value: z.output<typeof MarkdownLineageOrigin> }[] = []
        try {
          const text = await readFile(state.path, "utf8")
          if (sum(text) !== value.after.digest || Buffer.byteLength(text) !== value.after.bytes)
            throw new Error("Markdown own write projection bytes changed")
          if (Buffer.byteLength(text) > 1048576) throw new ConfigIntentRefusal("metadata-overflow")
          const projected = projectMarkdown(text)
          if (
            projected.excluded.some((field) => field.reason === "unsupported" || field.reason === "invalid-safe-field")
          )
            throw new ConfigIntentRefusal("unsupported-fields")
          const digest = markdownDigest(projected)
          for (const graph of graphs.values())
            for (const source of graph.markdown) {
              const previous = MarkdownLineageOrigin.parse(markdownRevisions.get(source) ?? source)
              if (key(previous.path) !== key(state.path)) continue
              if (matches(previous, value.after)) continue
              if (!matches(previous, value.before)) throw new Error("Markdown own write loaded predecessor changed")
              const history = [
                ...(previous.history ?? []),
                MarkdownOrigin.parse({
                  path: previous.path,
                  digest: previous.digest,
                  bytes: previous.bytes,
                  identity: previous.identity,
                  kind: previous.kind,
                  name: previous.name,
                  trusted: previous.trusted,
                  order: previous.order,
                  projection: previous.projection,
                }),
              ]
              if (history.length > 64) throw new ConfigIntentRefusal("metadata-overflow")
              updates.push({
                source,
                value: freeze(
                  MarkdownLineageOrigin.parse({ ...previous, ...value.after, projection: digest, history }),
                ),
              })
            }
        } catch (err) {
          finish(err)
          if (err instanceof ConfigIntentRefusal || err instanceof z.ZodError) {
            uncertain.set(key(state.path), value.after)
            return
          }
          throw err
        }
        for (const update of updates) markdownRevisions.set(update.source, update.value)
        finish()
      } catch (err) {
        finish(err)
        throw err
      }
    },
  })
}

/** Join the actual accepted loader invocation, including substitutions and schema acceptance. */
export function track<T>(token: Graph, work: () => Promise<T>): Promise<T> {
  if (closing || !graphs.has(token)) return Promise.reject(new Error("Configuration origin intake is terminal"))
  const task = work()
  const joined = task.then(
    () => undefined,
    (err) => {
      failed(token, err)
    },
  )
  pending.add(joined)
  void joined.then(() => pending.delete(joined))
  return task
}

/** Synchronous lifetime admission precedes the actual trusted/untrusted source reader. */
export async function readMarkdown(token: Graph | undefined, file: string, read: () => Promise<string>) {
  if (!token) return { text: await read(), token: undefined }
  if (closing || !graphs.has(token)) throw new Error("Configuration origin intake is terminal")
  registerProcessProfile([file])
  try {
    const before = await lstat(file, { bigint: true })
    const text = await read()
    const actual = await realpath(file)
    const after = await lstat(file, { bigint: true })
    const bytes = await readFile(file)
    if (
      key(actual) !== key(file) ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      !bytes.equals(Buffer.from(text))
    )
      throw new Error("Loaded Markdown physical origin changed")
    const value = Object.freeze({})
    markdown.set(value, { graph: token, file: actual, text, dev: before.dev, ino: before.ino })
    return { text, token: value }
  } catch (err) {
    failed(token, err)
    throw err
  }
}
export function bindMarkdown(token: object | undefined, object: object) {
  if (!token) return
  const value = markdown.get(token)
  if (!value) throw new Error("Markdown origin ticket is unknown")
  markdown.set(object, value)
}
/** Only real final-schema acceptance can turn a pre-substitution read into loaded evidence. */
export function acceptMarkdown(
  token: Graph | undefined,
  object: object,
  kind: "agent" | "command" | "mode",
  name: string,
  trusted: boolean,
) {
  if (!token) return
  const state = graphs.get(token)
  const value = markdown.get(object)
  if (!state || !value || value.graph !== token) throw new Error("Markdown acceptance lacks its actual source read")
  try {
    if (state.markdown.length >= 256) throw new ConfigIntentRefusal("metadata-overflow")
    const projection = projectMarkdown(value.text)
    if (projection.excluded.some((field) => field.reason === "unsupported" || field.reason === "invalid-safe-field"))
      throw new ConfigIntentRefusal("unsupported-fields")
    state.markdown.push(
      freeze(
        MarkdownOrigin.parse({
          path: value.file,
          digest: sum(value.text),
          bytes: Buffer.byteLength(value.text),
          identity: { dev: value.dev.toString(), ino: value.ino.toString() },
          kind,
          name,
          trusted,
          order: state.markdown.length,
          projection: markdownDigest(projection),
        }),
      ),
    )
  } catch (err) {
    state.failures.push(err)
  }
}

/** Transport only frozen evidence after loaded config work has settled. */
export function snapshot() {
  if (graphs.size && (!closing || pending.size)) throw new Error("Configuration origin closure is incomplete")
  if (graphs.size > 128) throw new ConfigIntentRefusal("metadata-overflow")
  if (failures.length) throw new ConfigIntentRefusal("origin-uncertain")
  const result = [...graphs]
    .sort(([a], [b]) => a.id.localeCompare(b.id))
    .map(([token, state]) => {
      if (state.failures.some((error) => error instanceof ConfigIntentRefusal && error.code === "metadata-overflow"))
        throw new ConfigIntentRefusal("metadata-overflow")
      if (state.documents.length > 256) throw new ConfigIntentRefusal("metadata-overflow")
      if (state.failures.length) throw new ConfigIntentRefusal("origin-uncertain")
      if (
        state.documents.some((source) =>
          (revisions.get(source) ?? source).excluded.some(
            (field) => field.reason === "unsupported" || field.reason === "invalid-safe-field",
          ),
        )
      )
        throw new ConfigIntentRefusal("unsupported-fields")
      return freeze(
        LineageIntent.parse({
          format: "raya.config-intent",
          version: 3,
          graph: token.id,
          parser: state.parser,
          roots: state.roots,
          directory: state.directory,
          documents: state.documents.map((document) => revisions.get(document) ?? document),
          markdown: state.markdown.map((origin) => markdownRevisions.get(origin) ?? origin),
          reviewOnly: true,
          activation: "held",
          coverage: "loaded-json-and-markdown-config-only",
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        }),
      )
    })
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new ConfigIntentRefusal("metadata-overflow")
  return Object.freeze(result)
}

/** Preserve actual merge operands, including cached global documents; no filename-derived precedence. */
export function combine(target: object, source: object, result: object) {
  sides.set(result, Object.freeze([...(sides.get(target) ?? []), ...(sides.get(source) ?? [])]))
}
export function inherit(source: object, result: object) {
  sides.set(result, sides.get(source) ?? [])
}
export function ordered(token: Graph, documents: readonly object[]) {
  const state = graphs.get(token)
  if (!state) throw new Error("Configuration intent graph is unknown")
  state.documents = Object.freeze(documents.flatMap((object) => sides.get(object) ?? []))
}
export function unavailable(token: Graph) {
  const state = graphs.get(token)
  if (!state) throw new Error("Configuration intent graph is unknown")
  state.failures.push(new Error("Loaded virtual configuration lacks physical origin evidence"))
}
export function failed(token: Graph, err: unknown) {
  const state = graphs.get(token)
  if (!state) throw new Error("Configuration intent graph is unknown")
  state.failures.push(err)
}

/** Diagnostic provenance only. Explicit policy and fresh physical identity/digest checks do not mint image authority. */
export async function observe(policy: SourcePolicy) {
  const selected = [...graphs].map(([token, state]) => ({
    token,
    state: {
      ...state,
      documents: state.documents.map((document) => revisions.get(document) ?? document),
      markdown: state.markdown.map((origin) => markdownRevisions.get(origin) ?? origin),
      failures: [...state.failures, ...failures],
    },
  }))
  if (selected.length > 128) throw new Error("Configuration source graphs exceed bounds")
  const physical = await validatePolicy(policy)
  const result = []
  for (const { token, state } of selected) {
    if (state.failures.length) throw new AggregateError(state.failures, "Configuration source intent remains uncertain")
    for (const root of Object.values(state.roots))
      if (!covers(physical, root) || key(await realpath(root)) !== key(root))
        throw new Error("Configuration source graph escapes canonical producer policy")
    if (
      state.directory &&
      (!covers(physical, state.directory) || key(await realpath(state.directory)) !== key(state.directory))
    )
      throw new Error("Configuration source directory escapes canonical producer policy")
    for (const document of [...state.documents, ...state.markdown]) {
      if (!covers(physical, document.path)) throw new Error("Loaded configuration origin escapes producer policy")
      if (
        "excluded" in document &&
        document.excluded.some((field) => field.reason === "unsupported" || field.reason === "invalid-safe-field")
      )
        throw new Error("Configuration intent has unsupported safe fields")
      const actual = await realpath(document.path)
      const info = await lstat(document.path, { bigint: true })
      const pin = pins.get(document) ?? { dev: BigInt(document.identity.dev), ino: BigInt(document.identity.ino) }
      if (
        key(actual) !== key(document.path) ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        !pin ||
        pin.dev !== info.dev ||
        pin.ino !== info.ino ||
        sum(await readFile(document.path)) !== document.digest
      )
        throw new Error("Loaded configuration origin changed after parsing")
    }
    result.push(
      freeze(
        LineageIntent.parse({
          format: "raya.config-intent",
          version: 3,
          graph: token.id,
          parser: state.parser,
          roots: state.roots,
          directory: state.directory,
          documents: state.documents,
          markdown: state.markdown.map((origin) => markdownRevisions.get(origin) ?? origin),
          reviewOnly: true,
          activation: "held",
          coverage: "loaded-json-and-markdown-config-only",
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        }),
      ),
    )
  }
  return Object.freeze(result)
}
export const ConfigIntent = {
  graph,
  loaded,
  combine,
  inherit,
  ordered,
  unavailable,
  failed,
  observe,
  retire,
  snapshot,
  track,
  writing,
  reserveMarkdown,
  readMarkdown,
  bindMarkdown,
  acceptMarkdown,
}
