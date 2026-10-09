import path from "node:path"
import { mkdir, open } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, sha } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { release } from "../control/catalog-capture"
import { setup as configure } from "../setup-v2"
import type { Setup } from "../settings"
import { current } from "./catalog"
import { images, fingerprint, cohort } from "./reuse-catalog"
import { descriptor, selection, type Descriptor } from "./descriptor"
import { protection } from "./protection"
import { observe, type Retrieval } from "./upgrade-observe-v2"
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
  return { path: file, bytes: raw.length, sha256: result.digest }
}

async function packaged(extension: string) {
  const base = path.join(extension, "script", "memory")
  const entries = [
    ...Object.entries(release).map(([name, digest]) => [name, path.join(base, "service", name), digest]),
    ...Object.entries(images).map(([name, digest]) => [name, path.join(base, name), digest]),
    ["supervise.py", path.join(base, "supervise.py"), current],
  ]
  return Promise.all(
    entries.map(async ([name, file, digest]) => {
      await directory(path.dirname(file))
      const result = await image(file)
      check(result.digest === digest, "Packaged v2 upgrade source differs")
      return { name, file, ...result }
    }),
  )
}

function previous(plan: Record<string, unknown>): Retrieval {
  check(
    typeof plan.source === "string" && plan.env && typeof plan.env === "object" && !Array.isArray(plan.env),
    "Original reusable Retrieval plan required",
  )
  const env = plan.env as Record<string, unknown>
  check(typeof env.RAYA_RETRIEVAL_RELEASE_SHA256 === "string", "Original selected Retrieval release required")
  const pins = cohort(env.RAYA_RETRIEVAL_RELEASE_SHA256)
  check(
    plan.source_sha256 &&
      typeof plan.source_sha256 === "object" &&
      !Array.isArray(plan.source_sha256) &&
      isDeepStrictEqual({ ...plan.source_sha256 }, pins),
    "Original selected Retrieval cohort differs",
  )
  return { source: plan.source, pins, release: env.RAYA_RETRIEVAL_RELEASE_SHA256 }
}

/** V2 activation replaces both immutable code selections, preserving originals and fresh receipt ownership. */
export async function activate(input: Descriptor, setup: Setup, extension: string, id: string) {
  check(/^[a-f0-9]{32}$/.test(id), "Exact upgrade generation required")
  const cfg = descriptor(input)
  check(cfg.version === 2 && setup.version === 2, "Explicit paired capture setup required")
  const selected = await selection(cfg, setup)
  check(typeof selected.plan.source === "string" && selected.retrieval, "Original paired sources required")
  const prior = previous(selected.retrieval)
  const sid = await protection(cfg.root)
  check(
    sid === cfg.namespaces.memory.sid && sid === cfg.namespaces.retrieval.sid,
    "Original selected upgrade owner differs",
  )
  const before = await observe(cfg, prior)
  const assets = await packaged(extension)
  const source = path.join(cfg.root, "raya-memory-source-upgrade-" + id)
  await mkdir(source)
  await directory(source)
  await mkdir(path.join(source, "retrieval"))
  await mkdir(path.join(source, "retrieval_reuse"))
  const refs = []
  for (const item of assets) refs.push({ name: item.name, ref: await save(path.join(source, item.name), item.raw) })
  const observed = await observe(cfg, prior, source)
  check(
    isDeepStrictEqual(observed.prior, before.prior) && isDeepStrictEqual(observed.retrieval, before.retrieval),
    "Original sources changed during upgrade",
  )
  const mapping = new Map(
    observed.images
      .filter((row) => path.basename(row.path) !== "supervise.py")
      .map((row) => {
        const name = path.relative(source, row.path).replace(/\\/g, "/")
        return [path.join(name.includes("/") ? prior.source : String(selected.plan.source), name), row] as const
      }),
  )
  const supervisor = observed.images.find((row) => normalize(row.path) === normalize(path.join(source, "supervise.py")))
  check(supervisor, "New supervisor observation required")
  const activation = { previous: prior, directories: observed.directories.slice(1) }
  const base = { path: selected.plan.source, pins: setup.source_sha256 }
  const files = [
    selected.files[0],
    selected.files[1],
    ...[2, 3].map((index) => ({
      raw: project(
        selected.files[index].raw,
        source,
        release,
        mapping,
        supervisor,
        observed.directories[0],
        base,
        activation,
      ),
    })),
  ]
  const next = await fresh(
    descriptor({ ...cfg, supervisor: refs.find((row) => row.name === "supervise.py")!.ref }),
    path.join(cfg.root, "raya-memory-fresh-" + id),
    files,
  )
  const changed = configure({ ...setup, source_sha256: release }, setup.origin)
  await selection(next, changed)
  const after = await selection(cfg, setup)
  check(
    after.files.every(
      (row, index) => row.tuple === selected.files[index].tuple && row.digest === selected.files[index].digest,
    ),
    "Original selected images changed during upgrade",
  )
  const final = await observe(cfg, prior, source, next.namespaces)
  check(
    isDeepStrictEqual(final.prior, before.prior) &&
      isDeepStrictEqual(final.retrieval, before.retrieval) &&
      isDeepStrictEqual(final.images, observed.images) &&
      isDeepStrictEqual(final.directories, observed.directories) &&
      (await protection(cfg.root)) === sid,
    "Upgrade native evidence changed",
  )
  for (const row of assets) {
    const held = await image(row.file)
    check(held.tuple === row.tuple && held.digest === row.digest, "Packaged image changed during upgrade")
  }
  const value = {
    format: "raya.memory.runtime.upgrade.prepared" as const,
    version: 2 as const,
    id,
    previous: { setup, managed: cfg },
    next: { setup: changed, managed: next },
    source,
    original: before.prior,
    images: observed.images,
    directory: observed.directories[0],
    spaces: final.spaces,
    retrieval: {
      previous: { ...prior, images: before.retrieval },
      next: { source, pins: images, release: fingerprint },
      directories: observed.directories.slice(1),
    },
    producer: final.producer,
    programSHA: final.programSHA,
    requestSettlement: false,
    replay: false,
    indexConfirmed: false,
  }
  const receipt = await save(
    path.join(path.dirname(next.plan.path), "upgrade-prepared.json"),
    Buffer.from(JSON.stringify(value)),
  )
  return { ...value, receipt }
}
