import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import { z } from "zod"
import { check, document } from "../control/frames"
import { directory, image } from "../control/identity"
import { interpreter } from "../managed/catalog"
import { catalogs } from "../managed/reuse-catalog"
import { fingerprint } from "../failed-repair"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const location = z.string().min(1).max(4096).refine(path.isAbsolute, "Absolute media runtime path required")
const ref = z.object({ path: location, sha256: hash, bytes: z.number().int().positive().max(16777216) }).strict()
const schema = z
  .object({
    format: z.literal("raya.media.runtime.v1"),
    python: ref,
    dependencies: location,
    inventory: ref,
    model: ref,
  })
  .strict()
const file = z
  .object({ path: z.string().min(1).max(4096), bytes: z.number().int().min(0).max(2147483648), sha256: hash })
  .strict()
const inventory = z
  .object({ format: z.literal("raya.media.dependencies.v1"), root: location, files: z.array(file).min(1).max(65536) })
  .strict()
const manifest = z
  .object({
    source: z.literal("google/embeddinggemma-2"),
    revision: z.literal("914f7f89142e33e77833254d9c9b90c3cef7303b"),
    status: z.literal("downloaded_verified"),
    path: location,
    files: z
      .array(
        z
          .object({
            name: z.string().min(1).max(4096),
            bytes: z.number().int().positive().max(2147483648),
            sha256: hash,
          })
          .passthrough(),
      )
      .length(15),
  })
  .passthrough()

// Independently qualified media images; existing Memory releases remain immutable.
const pins: Record<string, string> = Object.freeze({
  "media/supervisor.py": "3d4b7cf6b5895d00cce76f20ce8cf5dd790727964e4722e471ef1dfe505f2e38",
  "media/worker.py": "ec1061669ce674cc986f887bf08190621762f64d42d54cd2248830ea26021869",
  "media/session.py": "750242844fe1ccaa4bb556689541696eb72984a6e6a0639e4739c2ea12028bdc",
  "media/library.py": "d2fc538fbdc95bcf83f5949946b8a46e683a68c13758c07d565b945cf1a0e66a",
  "media/encoder.py": "5797459720dc326c62477372f94d28614fb77602573d02d58a7f95fa48e4324a",
  "retrieval/owner.py": "fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446",
})

function relative(root: string, name: string) {
  const parts = name.split("/")
  check(
    parts.every(
      (part) => part && ![".", ".."].includes(part) && !/[\\<>:"|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part),
    ),
    "Ordinary relative runtime inventory path required",
  )
  const target = path.join(root, ...parts)
  const remaining = path.relative(root, target)
  check(
    remaining && !remaining.startsWith("..") && !path.isAbsolute(remaining),
    "Runtime inventory leaves its selected root",
  )
  return target
}

function tuple(value: BigIntStats) {
  return [value.dev, value.ino, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
}

async function retained(input: z.infer<typeof ref>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await directory(path.dirname(input.path))
  signal?.throwIfAborted()
  const held = await image(input.path, 16777216)
  signal?.throwIfAborted()
  check(held.raw.length === input.bytes && held.digest === input.sha256, "Selected media runtime metadata changed")
  return held
}

async function streamed(target: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await directory(path.dirname(target))
  signal?.throwIfAborted()
  const before = await lstat(target, { bigint: true })
  signal?.throwIfAborted()
  check(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(expected.bytes),
    "Selected runtime file must be ordinary, single-link and exact-sized",
  )
  const held = await open(target, "r")
  const result = await (async () => {
    signal?.throwIfAborted()
    const opened = await held.stat({ bigint: true })
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(1048576)
    let bytes = 0
    for (;;) {
      signal?.throwIfAborted()
      const current = await held.read(buffer, 0, buffer.length, null)
      signal?.throwIfAborted()
      if (!current.bytesRead) break
      bytes += current.bytesRead
      check(bytes <= expected.bytes, "Selected runtime grew during verification")
      digest.update(buffer.subarray(0, current.bytesRead))
    }
    const final = await held.stat({ bigint: true })
    const after = await lstat(target, { bigint: true })
    signal?.throwIfAborted()
    check(
      [opened, final, after].every((value) => tuple(value) === tuple(before)) &&
        bytes === expected.bytes &&
        digest.digest("hex") === expected.sha256,
      "Selected runtime file changed or digest differs",
    )
    return { path: target, bytes, sha256: expected.sha256, tuple: tuple(before) }
  })().then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  )
  const ended = await held.close().then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  )
  if (!result.ok)
    throw ended.ok
      ? result.err
      : new AggregateError([result.err, ended.err], "Runtime verification and file close failures retained")
  if (!ended.ok) throw ended.err
  return result.value
}

async function listing(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const files: string[] = []
  const dirs: { path: string; tuple: string }[] = []
  const folders = [root]
  let count = 0
  while (folders.length) {
    const folder = folders.pop()!
    signal?.throwIfAborted()
    await directory(folder)
    signal?.throwIfAborted()
    const before = await lstat(folder, { bigint: true })
    dirs.push({ path: folder, tuple: tuple(before) })
    const entries = await readdir(folder, { withFileTypes: true })
    signal?.throwIfAborted()
    for (const item of entries) {
      signal?.throwIfAborted()
      count++
      check(count <= 131072, "Media runtime directory inventory exceeds its bound")
      const target = path.join(folder, item.name)
      check(
        target.length <= 4096 && path.relative(root, target).split(path.sep).length <= 64,
        "Media runtime nesting exceeds its bound",
      )
      const value = await lstat(target)
      signal?.throwIfAborted()
      check(!value.isSymbolicLink(), "Media runtime inventory contains a linked path")
      if (value.isDirectory()) {
        folders.push(target)
        continue
      }
      check(value.isFile(), "Media runtime inventory contains a special file")
      files.push(path.relative(root, target).replace(/\\/g, "/"))
      check(files.length <= 65536, "Media runtime file inventory exceeds its bound")
    }
    check(
      tuple(await lstat(folder, { bigint: true })) === tuple(before),
      "Media dependency directory changed during listing",
    )
  }
  return { files: files.sort(), dirs: dirs.sort((a, b) => a.path.localeCompare(b.path)) }
}

export function runtime(input: unknown) {
  const value = schema.parse(input)
  check(
    value.python.sha256 === interpreter && value.model.sha256 === catalogs["google--embeddinggemma-2.json"],
    "Reviewed media interpreter and Gemma manifest required",
  )
  return value
}

const proofs = new WeakMap<
  object,
  {
    value: {
      runtime: z.infer<typeof schema>
      inventory: z.infer<typeof inventory>
      model: z.infer<typeof manifest>
      release: string
    }
    listing: Awaited<ReturnType<typeof listing>>
    leaves: { path: string; tuple: string }[]
    metadata: { ref: z.infer<typeof ref>; tuple: string }[]
  }
>()

/** Verify executable dependencies and manifest metadata; checkpoint leaves remain untouched. */
export async function dependencies(input: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const cfg = runtime(input)
  await directory(cfg.dependencies)
  const held = await retained(cfg.inventory, signal)
  const selected = inventory.parse(document(held.raw, 16777216).value)
  check(selected.root === cfg.dependencies, "Media dependency inventory belongs to a different selected root")
  const names = selected.files.map((item) => item.path).sort()
  check(new Set(names.map((name) => name.toLowerCase())).size === names.length, "Duplicate runtime inventory paths")
  const original = await listing(cfg.dependencies, signal)
  check(isDeepStrictEqual(original.files, names), "Selected media dependency inventory is incomplete")
  const snapshots = []
  for (const item of selected.files) snapshots.push(await streamed(relative(cfg.dependencies, item.path), item, signal))
  check(
    isDeepStrictEqual(await listing(cfg.dependencies, signal), original),
    "Media dependency inventory changed during verification",
  )
  const python = await retained(cfg.python, signal)
  const checkpoint = await retained(cfg.model, signal)
  const model = manifest.parse(document(checkpoint.raw, 16777216).value)
  check(
    new Set(model.files.map((item) => item.name.toLowerCase())).size === model.files.length,
    "Duplicate model checkpoint inventory paths",
  )
  for (const item of model.files) relative(model.path, item.name)
  const value = {
    runtime: cfg,
    inventory: selected,
    model,
    release: fingerprint({
      python: { sha256: cfg.python.sha256, bytes: cfg.python.bytes },
      inventory: { sha256: cfg.inventory.sha256, bytes: cfg.inventory.bytes },
      model: { sha256: cfg.model.sha256, bytes: cfg.model.bytes },
    }),
  }
  proofs.set(value, {
    value: structuredClone(value),
    listing: original,
    leaves: snapshots,
    metadata: [
      { ref: { ...cfg.inventory }, tuple: held.tuple },
      { ref: { ...cfg.model }, tuple: checkpoint.tuple },
      { ref: { ...cfg.python }, tuple: python.tuple },
    ],
  })
  await current(value, signal)
  return value
}

/** Recheck the original bound proof before admission and after result delivery. */
export async function current(snapshot: object, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const proof = proofs.get(snapshot)
  check(proof && isDeepStrictEqual(snapshot, proof.value), "Original media runtime snapshot required")
  for (const row of proof.metadata) {
    check((await retained(row.ref, signal)).tuple === row.tuple, "Media runtime metadata changed during verification")
  }
  for (const row of proof.leaves) {
    signal?.throwIfAborted()
    const held = await lstat(row.path, { bigint: true })
    signal?.throwIfAborted()
    check(
      held.isFile() && !held.isSymbolicLink() && tuple(held) === row.tuple,
      "Media runtime leaf changed after verification",
    )
  }
  check(
    isDeepStrictEqual(await listing(proof.value.runtime.dependencies, signal), proof.listing),
    "Media dependency inventory changed after verification",
  )
}

/** Inspect complete selected dependency and checkpoint bytes without importing code or loading a model. */
export async function validate(input: unknown, signal?: AbortSignal) {
  const value = await dependencies(input, signal)
  const proof = proofs.get(value)!
  await directory(value.model.path)
  signal?.throwIfAborted()
  for (const item of value.model.files)
    proof.leaves.push(await streamed(relative(value.model.path, item.name), item, signal))
  await current(value, signal)
  return value
}

/** Only fixed packaged media code can participate in a new release. Existing Memory pins remain independent. */
export async function sources(extension: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const refs: Record<string, z.infer<typeof ref>> = {}
  const snapshots: Record<string, string> = {}
  for (const [name, digest] of Object.entries(pins)) {
    check(/^[a-f0-9]{64}$/.test(digest), "Media package source release has not been frozen")
    const target = path.join(extension, "script", "memory", name)
    signal?.throwIfAborted()
    await directory(path.dirname(target))
    signal?.throwIfAborted()
    const held = await image(target, 16777216)
    signal?.throwIfAborted()
    check(held.digest === digest, "Packaged media source differs from its frozen release")
    refs[path.basename(name)] = { path: target, sha256: held.digest, bytes: held.raw.length }
    snapshots[path.basename(name)] = held.tuple
  }
  for (const [name, row] of Object.entries(refs))
    check((await retained(row, signal)).tuple === snapshots[name], "Media source cohort changed during verification")
  return {
    supervisor: refs["supervisor.py"],
    sources: refs,
    release: fingerprint({
      interpreter,
      sources: Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [name, { sha256: ref.sha256, bytes: ref.bytes }]),
      ),
    }),
  }
}
