import path from "node:path"
import { mkdir, open } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, sha } from "../control/frames"
import { directory, image } from "../control/identity"
import { release } from "../control/catalog-capture"
import { setup as configure } from "../setup-v2"
import type { Setup } from "../settings"
import { current } from "./catalog"
import { descriptor, selection, type Descriptor } from "./descriptor"
import { protection } from "./protection"
import { observe } from "./upgrade-observe"
import { project } from "./upgrade"
import { fresh } from "./generation"

async function save(file: string, raw: Buffer) {
  check(raw.length > 0 && raw.length <= 1048576, "Bounded upgrade publication required")
  const held = await open(file, "wx", 0o600)
  try {
    await held.writeFile(raw)
    await held.sync()
  } finally {
    await held.close()
  }
  const result = await image(file)
  check(result.digest === sha(raw) && result.raw.equals(raw), "Upgrade publication readback differs")
  return Object.freeze({ path: file, bytes: raw.length, sha256: result.digest })
}

async function packaged(extension: string) {
  const source = path.join(extension, "script", "memory")
  await directory(source)
  const images = await Promise.all(
    Object.entries(release).map(async ([name, digest]) => {
      const file = path.join(source, "service", name)
      await directory(path.dirname(file))
      const result = await image(file)
      check(result.digest === digest, "Packaged upgrade source differs")
      return { name, file, ...result }
    }),
  )
  const file = path.join(source, "supervise.py")
  const result = await image(file)
  check(result.digest === current, "Exact packaged current supervisor required")
  return [...images, { name: "supervise.py", file, ...result }]
}

/** Create a disjoint immutable runtime and fresh receipt namespaces. Partial directories remain sticky; no saved state changes. */
export async function materialize(input: Descriptor, setup: Setup, extension: string, id: string) {
  check(/^[a-f0-9]{32}$/.test(id), "Exact upgrade generation required")
  const cfg = descriptor(input)
  check(cfg.version === 2 && setup.version === 2, "Explicit paired capture setup required")
  const selected = await selection(cfg, setup)
  check(typeof selected.plan.source === "string", "Original Memory source required")
  const sid = await protection(cfg.root)
  check(
    sid === cfg.namespaces.memory.sid && sid === cfg.namespaces.retrieval.sid,
    "Original selected upgrade owner differs",
  )
  const before = await observe(cfg)
  const images = await packaged(extension)
  const source = path.join(cfg.root, "raya-memory-source-upgrade-" + id)
  await mkdir(source)
  await directory(source)
  const refs = []
  for (const item of images) refs.push(await save(path.join(source, item.name), item.raw))
  const observed = await observe(cfg, source)
  check(isDeepStrictEqual(observed.prior, before.prior) && observed.directory, "Original source changed during upgrade")
  const replacements = new Map(
    observed.images
      .filter((item) => path.basename(item.path) !== "supervise.py")
      .map((item) => [path.join(selected.plan.source as string, path.basename(item.path)), item]),
  )
  const supervisor = observed.images.find((item) => path.basename(item.path) === "supervise.py")
  check(supervisor, "New supervisor observation required")
  const prior = { path: selected.plan.source, pins: setup.source_sha256 }
  const files = [
    selected.files[0],
    selected.files[1],
    { raw: project(selected.files[2].raw, source, release, replacements, supervisor, observed.directory, prior) },
    { raw: project(selected.files[3].raw, source, release, replacements, supervisor, observed.directory, prior) },
  ]
  const next = await fresh(
    descriptor({ ...cfg, supervisor: refs.at(-1)! }),
    path.join(cfg.root, "raya-memory-fresh-" + id),
    files,
  )
  const changed = configure({ ...setup, source_sha256: release }, setup.origin)
  await selection(next, changed)
  const after = await selection(cfg, setup)
  check(
    after.files.every(
      (item, index) => item.tuple === selected.files[index].tuple && item.digest === selected.files[index].digest,
    ),
    "Original selected images changed during upgrade",
  )
  const final = await observe(cfg, source, next.namespaces)
  check(
    isDeepStrictEqual(final.prior, before.prior) &&
      isDeepStrictEqual(final.images, observed.images) &&
      isDeepStrictEqual(final.directory, observed.directory) &&
      (await protection(cfg.root)) === sid,
    "Upgrade native evidence changed",
  )
  for (const item of images) {
    const current = await image(item.file)
    check(current.tuple === item.tuple && current.digest === item.digest, "Packaged image changed during upgrade")
  }
  const value = Object.freeze({
    format: "raya.memory.runtime.upgrade.prepared",
    version: 1,
    id,
    previous: { setup, managed: cfg },
    next: { setup: changed, managed: next },
    source,
    original: before.prior,
    images: observed.images,
    directory: observed.directory,
    spaces: final.spaces,
    producer: final.producer,
    programSHA: final.programSHA,
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  })
  const receipt = await save(
    path.join(path.dirname(next.plan.path), "upgrade-prepared.json"),
    Buffer.from(JSON.stringify(value)),
  )
  return Object.freeze({ ...value, receipt })
}
