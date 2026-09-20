import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, link, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { z } from "zod"
import type { Package } from "./package-vault"
import { verify } from "./update-vsix"

const key = "raya.update.installation.v1"
const legacy = z.object({
  version: z.string().min(1).max(256),
  previous: z.string().min(1).max(256),
  phase: z.enum(["installing", "awaiting-reload"]),
})
const bytes = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024 * 1024),
})
const rollback = z.object({
  version: z.string().min(1).max(256),
  target: z.string().min(1).max(64),
  package: z.string().min(1).max(32768).refine(isAbsolute),
  artifact: bytes,
  binary: bytes,
})
const base = z.object({
  schema: z.literal(3),
  version: z.string().min(1).max(256),
  previous: z.string().min(1).max(256),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  target: z.string().min(1).max(64),
  asset: z.object({
    name: z.string().min(1).max(512),
    url: z.string().url().max(4096),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  artifact: bytes,
  binary: bytes,
  package: z.string().min(1).max(32768).refine(isAbsolute),
  rollback,
})
const exact = (value: z.infer<typeof base>) =>
  value.asset.size === value.artifact.size && value.asset.digest.slice("sha256:".length) === value.artifact.digest
const safe = (value: z.infer<typeof base>) =>
  value.rollback.version === value.previous && value.rollback.target === value.target
const request = base
  .refine(exact, "The retained package receipt does not match the release asset.")
  .refine(safe, "The retained rollback package does not match the active Raya version and platform.")
const record = base
  .extend({
    phase: z.enum([
      "installing",
      "awaiting-reload",
      "rollback-installing",
      "rollback-awaiting-reload",
      "rollback-unknown",
    ]),
  })
  .refine(exact, "The retained package receipt does not match the release asset.")
  .refine(safe, "The retained rollback package does not match the active Raya version and platform.")
const prior = z.object({
  schema: z.literal(2),
  version: z.string().min(1).max(256),
  previous: z.string().min(1).max(256),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  target: z.string().min(1).max(64),
  asset: z.object({
    name: z.string().min(1).max(512),
    url: z.string().url().max(4096),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  artifact: bytes,
  package: z.string().min(1).max(32768).refine(isAbsolute),
  phase: z.enum(["installing", "awaiting-reload"]),
})
const saved = z.union([record, prior])

export type InstallRequest = z.infer<typeof request>
export type InstallRecord = z.infer<typeof saved> | z.infer<typeof legacy>
type State = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }

function receipt(
  left: { artifact: z.infer<typeof bytes>; binary: z.infer<typeof bytes> },
  right: { artifact: z.infer<typeof bytes>; binary: z.infer<typeof bytes> },
) {
  return (
    left.artifact.digest === right.artifact.digest &&
    left.artifact.size === right.artifact.size &&
    left.binary.digest === right.binary.digest &&
    left.binary.size === right.binary.size
  )
}

function same(left: InstallRecord, right: InstallRequest) {
  if (!("schema" in left) || left.schema === 2) return false
  return (
    left.schema === right.schema &&
    left.version === right.version &&
    left.previous === right.previous &&
    left.repo === right.repo &&
    left.target === right.target &&
    left.asset.name === right.asset.name &&
    left.asset.url === right.asset.url &&
    left.asset.size === right.asset.size &&
    left.asset.digest === right.asset.digest &&
    receipt(left, right) &&
    left.package === right.package &&
    left.rollback.version === right.rollback.version &&
    left.rollback.target === right.rollback.target &&
    receipt(left.rollback, right.rollback)
  )
}

function parse(raw: string) {
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.", {
      cause: err,
    })
  }
}

/** One exact update owns installer dispatch across extension hosts. Uncertain dispatch is never replayed. */
export class Installation {
  private readonly file: string | undefined
  private readonly locks: string | undefined
  private readonly root: string | undefined

  constructor(
    private readonly state: State,
    root?: string,
  ) {
    this.root = root
    this.file = root ? join(root, "update-installation.json") : undefined
    this.locks = root ? join(root, ".update-locks") : undefined
  }

  private lock<T>(work: () => Promise<T>) {
    if (!this.locks) return work()
    return Flock.withLock("raya-update-installation", work, {
      dir: this.locks,
      staleMs: 60_000,
      timeoutMs: 30_000,
    })
  }

  private async read(): Promise<InstallRecord | undefined> {
    if (this.file) {
      const raw = await readFile(this.file, "utf8").then(
        (value) => value,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        },
      )
      if (raw !== undefined) {
        const value = saved.safeParse(parse(raw))
        if (!value.success)
          throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.")
        if ("schema" in value.data && value.data.schema === 3) this.rollbackPath(value.data)
        return value.data
      }
    }
    const raw = this.state.get(key)
    if (raw === undefined) return undefined
    const parsed = legacy.safeParse(raw)
    if (!parsed.success)
      throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.")
    return parsed.data
  }

  private async write(value: InstallRecord) {
    if (!this.file) {
      await this.state.update(key, value)
      return
    }
    await this.state.update(key, undefined)
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, this.file)
    } finally {
      await rm(tmp, { force: true })
    }
  }

  private rollbackPath(value: { rollback: { artifact: { digest: string }; package: string } }) {
    if (!this.root) throw new Error("A durable Raya update installation requires a storage root.")
    const expected = resolve(this.root, "update-rollback", `raya.${value.rollback.artifact.digest}.vsix`)
    if (resolve(value.rollback.package) !== expected)
      throw new Error("The saved Raya rollback package is outside its durable update journal.")
    return expected
  }

  private async stage(value: InstallRequest) {
    if (!this.root) throw new Error("A durable Raya update installation requires a storage root.")
    await verify(value.rollback.package, { name: "raya", publisher: "eden", ...value.rollback })
    const path = resolve(this.root, "update-rollback", `raya.${value.rollback.artifact.digest}.vsix`)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await copyFile(value.rollback.package, tmp, constants.COPYFILE_EXCL)
      const handle = await open(tmp, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await verify(tmp, { name: "raya", publisher: "eden", ...value.rollback })
      const linked = await link(tmp, path).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "EEXIST") return false
          throw err
        },
      )
      if (!linked) await verify(path, { name: "raya", publisher: "eden", ...value.rollback })
    } finally {
      await rm(tmp, { force: true })
    }
    return request.parse({ ...value, rollback: { ...value.rollback, package: path } })
  }

  private async clear(value?: InstallRecord) {
    await this.state.update(key, undefined)
    if (this.file) await rm(this.file, { force: true })
    if (value && "schema" in value && value.schema === 3) await rm(this.rollbackPath(value), { force: true })
    if (this.root) await rm(join(this.root, "update-rollback"), { recursive: true, force: true })
  }

  run(input: InstallRequest, install: () => Promise<void>) {
    const value = request.parse(input)
    return this.lock(async () => {
      const prior = await this.read()
      if (prior) {
        if (!same(prior, value)) throw new Error("Another Raya update installation owns a different verified package.")
        return { dispatched: false as const, record: prior }
      }
      const retained = await this.stage(value)
      const installing = record.parse({ ...retained, phase: "installing" })
      await this.write(installing)
      await install()
      const complete = record.parse({ ...retained, phase: "awaiting-reload" })
      await this.write(complete)
      return { dispatched: true as const, record: complete }
    })
  }

  rollback(install: (path: string) => Promise<void>) {
    return this.lock(async () => {
      const prior = await this.read()
      if (!prior || !("schema" in prior) || prior.schema !== 3)
        throw new Error("No verified Raya rollback package is attached to this update installation.")
      if (prior.phase.startsWith("rollback-")) return { dispatched: false as const, record: prior }
      await verify(prior.rollback.package, { name: "raya", publisher: "eden", ...prior.rollback })
      const installing = record.parse({ ...prior, phase: "rollback-installing" })
      await this.write(installing)
      await install(prior.rollback.package).then(
        () => undefined,
        async (err) => {
          await this.write(record.parse({ ...prior, phase: "rollback-unknown" }))
          throw err
        },
      )
      const complete = record.parse({ ...prior, phase: "rollback-awaiting-reload" })
      await this.write(complete)
      return { dispatched: true as const, record: complete }
    })
  }

  recover(active?: Package): Promise<InstallRecord | undefined> {
    return this.lock(async () => {
      const value = await this.read()
      if (!value) {
        await this.clear()
        return undefined
      }
      if (!("schema" in value) || value.schema !== 3) return value
      const restored = "schema" in value && value.schema === 3 && value.phase.startsWith("rollback-")
      const expected = restored
        ? value.rollback
        : { version: value.version, target: value.target, artifact: value.artifact, binary: value.binary }
      if (
        !active ||
        active.version !== expected.version ||
        active.target !== expected.target ||
        active.artifact.digest !== expected.artifact.digest ||
        active.artifact.size !== expected.artifact.size ||
        active.binary.digest !== expected.binary.digest ||
        active.binary.size !== expected.binary.size
      )
        return value
      await this.clear(value)
      return undefined
    })
  }
}
