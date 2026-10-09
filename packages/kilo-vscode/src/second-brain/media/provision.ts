import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { lstat, open, readdir, link, unlink } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import { z } from "zod"
import { check, sha } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { descriptor, type Descriptor } from "../managed/descriptor"
import { catalogs, cohort } from "../managed/reuse-catalog"
import { parse } from "../managed/value"
import { protection } from "../managed/protection"
import { runtime } from "./catalog"

const limit = 16777216
const location = z.string().min(1).max(4096).refine(path.isAbsolute)
const ref = z
  .object({
    path: location,
    bytes: z.number().int().min(0).max(2147483648),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough()
const schema = z
  .object({
    format: z.literal("raya.memory.managed.supervisor"),
    version: z.literal(1),
    kind: z.literal("retrieval"),
    execution_admitted: z.literal(true),
    root: location,
    python_sha256: z.string(),
    dependencies: location,
    source: location,
    source_sha256: z.record(z.string(), z.string()),
    files: z.array(ref).min(1).max(131072),
    retrieval_protocol: z.literal("raya.retrieval.request.settlement.v2"),
    env: z.object({ RAYA_RETRIEVAL_RELEASE_SHA256: z.string() }).passthrough(),
  })
  .passthrough()

function relative(root: string, target: string) {
  const name = path.relative(root, target)
  check(name && !name.startsWith("..") && !path.isAbsolute(name), "Selected file must remain inside its root")
  const parts = name.split(path.sep)
  check(
    parts.every((part) => part && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part)),
    "Ordinary selected path required",
  )
  return parts.join("/")
}

function reference(row: z.infer<typeof ref>) {
  check(Number.isSafeInteger(row.bytes), "Exact selected byte count required")
  return { path: row.path, bytes: row.bytes, sha256: row.sha256 }
}

/** Derivation establishes selected metadata, never runtime or inference readiness. */
export function derive(input: Descriptor, raw: Uint8Array) {
  const cfg = descriptor(input)
  check(cfg.version === 2 && cfg.retrieval, "Selected reusable Retrieval descriptor required")
  relative(cfg.root, cfg.retrieval.path)
  check(
    raw.length <= limit && raw.length === cfg.retrieval.bytes && sha(raw) === cfg.retrieval.sha256,
    "Selected Retrieval plan bytes changed",
  )
  const plan = schema.parse(parse(raw))
  check(
    normalize(plan.root) === normalize(cfg.root) && plan.python_sha256 === cfg.python.sha256,
    "Selected Retrieval root or interpreter differs",
  )
  check(
    isDeepStrictEqual(plan.source_sha256, cohort(plan.env.RAYA_RETRIEVAL_RELEASE_SHA256)),
    "Selected Retrieval source cohort differs",
  )
  const files = plan.files.map(reference)
  const rows = new Map(files.map((item) => [normalize(item.path), item]))
  check(rows.size === files.length, "Duplicate selected runtime file")
  const python = rows.get(normalize(cfg.python.path))
  check(
    python && python.bytes === cfg.python.bytes && python.sha256 === cfg.python.sha256,
    "Selected interpreter inventory differs",
  )
  for (const [name, digest] of Object.entries(cohort(plan.env.RAYA_RETRIEVAL_RELEASE_SHA256))) {
    check(rows.get(normalize(path.join(plan.source, name)))?.sha256 === digest, "Selected source inventory differs")
  }
  const manifests = Object.entries(catalogs).map(([name, digest]) => {
    const matches = files.filter((item) => path.basename(item.path) === name && item.sha256 === digest)
    check(
      matches.length === 1 && matches[0].bytes > 0 && matches[0].bytes <= limit,
      "Exact selected model catalog required",
    )
    return matches[0]
  })
  const model = manifests.find((item) => path.basename(item.path) === "google--embeddinggemma-2.json")!
  const dependencies = files
    .filter((item) => {
      const name = path.relative(plan.dependencies, item.path)
      return name && !name.startsWith("..") && !path.isAbsolute(name)
    })
    .map((item) => ({ ...item, path: relative(plan.dependencies, item.path) }))
    .sort((a, b) => a.path.localeCompare(b.path))
  check(dependencies.length > 0 && dependencies.length <= 65536, "Bounded complete dependency inventory required")
  return {
    python,
    dependencies: plan.dependencies,
    model,
    inventory: { format: "raya.media.dependencies.v1" as const, root: plan.dependencies, files: dependencies },
    retrieval: { ...cfg.retrieval },
    release: plan.env.RAYA_RETRIEVAL_RELEASE_SHA256,
    qualified: false as const,
    inference: false as const,
  }
}

function tuple(value: BigIntStats) {
  return [value.dev, value.ino, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
}

async function streamed(target: string, row: { bytes: number; sha256: string }, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await directory(path.dirname(target))
  const before = await lstat(target, { bigint: true })
  check(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(row.bytes),
    "Ordinary exact selected dependency required",
  )
  const held = await open(target, "r")
  try {
    const opened = await held.stat({ bigint: true })
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(1048576)
    let bytes = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = await held.read(buffer, 0, buffer.length, null)
      signal?.throwIfAborted()
      if (!chunk.bytesRead) break
      bytes += chunk.bytesRead
      check(bytes <= row.bytes, "Selected dependency grew")
      digest.update(buffer.subarray(0, chunk.bytesRead))
    }
    const final = await held.stat({ bigint: true })
    const after = await lstat(target, { bigint: true })
    check(
      [opened, final, after].every((item) => tuple(item) === tuple(before)) &&
        bytes === row.bytes &&
        digest.digest("hex") === row.sha256,
      "Selected dependency bytes changed",
    )
    return { path: target, tuple: tuple(after) }
  } finally {
    await held.close()
  }
}

async function listing(root: string, signal?: AbortSignal) {
  const files: string[] = []
  const dirs: { path: string; tuple: string }[] = []
  async function walk(dir: string) {
    signal?.throwIfAborted()
    await directory(dir)
    const before = await lstat(dir, { bigint: true })
    dirs.push({ path: dir, tuple: tuple(before) })
    check(dirs.length <= 65536, "Dependency directory bound exceeded")
    for (const item of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const target = path.join(dir, item.name)
      check(!item.isSymbolicLink(), "Dependency links refused")
      if (item.isDirectory()) {
        await walk(target)
        continue
      }
      check(item.isFile(), "Ordinary dependency required")
      files.push(relative(root, target))
      check(files.length <= 65536, "Dependency file bound exceeded")
    }
    check(tuple(await lstat(dir, { bigint: true })) === tuple(before), "Dependency directory changed")
  }
  await walk(root)
  return { files: files.sort(), dirs }
}

async function publish(folder: string, raw: Uint8Array, signal?: AbortSignal) {
  check(raw.length > 0 && raw.length <= limit, "Bounded media metadata required")
  signal?.throwIfAborted()
  const id = randomUUID()
  const stage = path.join(folder, id + ".pending")
  const target = path.join(folder, id + ".json")
  const held = await open(stage, "wx", 0o600)
  try {
    await held.writeFile(raw)
    await held.sync()
  } finally {
    await held.close()
  }
  signal?.throwIfAborted()
  await link(stage, target)
  await unlink(stage)
  const read = await image(target, limit)
  check(read.raw.equals(Buffer.from(raw)) && read.digest === sha(raw), "Published media metadata readback differs")
  signal?.throwIfAborted()
  return { path: target, bytes: raw.length, sha256: read.digest }
}

async function empty(folder: string, signal?: AbortSignal) {
  const names = (await readdir(folder)).sort()
  check(
    names.length === 0 || isDeepStrictEqual(names, ["Requests", "Runs"]),
    "Empty selected-owner metadata folder required",
  )
  for (const name of names) {
    signal?.throwIfAborted()
    const dir = await directory(path.join(folder, name))
    check((await readdir(dir)).length === 0, "Empty metadata namespace required")
  }
}

async function published(refs: { path: string; bytes: number; sha256: string }[], signal?: AbortSignal) {
  for (const ref of refs) {
    signal?.throwIfAborted()
    const held = await image(ref.path, limit)
    check(held.digest === ref.sha256 && held.raw.length === ref.bytes, "Published metadata changed before acceptance")
  }
}

/** Publish into an existing caller-owned private folder; model leaves remain untouched. */
export async function prepare(input: Descriptor, folder: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const cfg = descriptor(input)
  check(cfg.version === 2 && cfg.retrieval, "Selected reusable Retrieval descriptor required")
  const dir = await directory(folder)
  const anchor = await lstat(dir, { bigint: true })
  const sid = await protection(dir)
  signal?.throwIfAborted()
  check(sid === cfg.namespaces.retrieval.sid, "Selected-owner metadata folder required")
  await empty(dir, signal)
  const selected = await image(cfg.retrieval.path, limit)
  signal?.throwIfAborted()
  const data = derive(cfg, selected.raw)
  const python = await image(data.python.path, limit)
  signal?.throwIfAborted()
  check(
    python.raw.length === data.python.bytes && python.digest === data.python.sha256,
    "Selected interpreter bytes changed",
  )
  const model = await image(data.model.path, limit)
  signal?.throwIfAborted()
  check(
    model.raw.length === data.model.bytes && model.digest === data.model.sha256,
    "Selected model catalog bytes changed",
  )
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
              name: z.string(),
              bytes: z.number().int().positive(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .passthrough(),
        )
        .length(15),
    })
    .passthrough()
    .parse(parse(model.raw))
  check(manifest.files.length === 15, "Selected model manifest differs")
  const before = await listing(data.dependencies, signal)
  check(
    isDeepStrictEqual(before.files, data.inventory.files.map((item) => item.path).sort()),
    "Selected dependency inventory incomplete",
  )
  const receipts = []
  for (const row of data.inventory.files)
    receipts.push(await streamed(path.join(data.dependencies, ...row.path.split("/")), row, signal))
  check(isDeepStrictEqual(await listing(data.dependencies, signal), before), "Selected dependency inventory changed")
  for (const row of receipts)
    check(
      tuple(await lstat(row.path, { bigint: true })) === row.tuple,
      "Selected dependency changed before publication",
    )
  const inventory = await publish(dir, Buffer.from(JSON.stringify(data.inventory)), signal)
  const value = runtime({
    format: "raya.media.runtime.v1",
    python: data.python,
    dependencies: data.dependencies,
    model: data.model,
    inventory,
  })
  const result = await publish(dir, Buffer.from(JSON.stringify(value)), signal)
  for (const [ref, original] of [
    [data.retrieval, selected],
    [data.python, python],
    [data.model, model],
  ] as const) {
    signal?.throwIfAborted()
    const current = await image(ref.path, limit)
    check(
      current.tuple === original.tuple && current.digest === original.digest,
      "Selected runtime changed before metadata acceptance",
    )
  }
  check((await protection(dir)) === sid, "Metadata owner changed")
  const final = await lstat(dir, { bigint: true })
  check(
    final.isDirectory() && !final.isSymbolicLink() && final.dev === anchor.dev && final.ino === anchor.ino,
    "Metadata directory identity changed",
  )
  check(
    isDeepStrictEqual(await listing(data.dependencies, signal), before),
    "Selected dependency inventory changed before acceptance",
  )
  for (const row of receipts) {
    signal?.throwIfAborted()
    check(tuple(await lstat(row.path, { bigint: true })) === row.tuple, "Selected dependency changed before acceptance")
  }
  await published([inventory, result], signal)
  signal?.throwIfAborted()
  return {
    runtime: value,
    selected: result,
    provenance: {
      retrieval: { ...data.retrieval, tuple: selected.tuple },
      python: data.python,
      model: data.model,
      inventory,
      sid,
      release: data.release,
    },
    qualified: false as const,
    inference: false as const,
  }
}
