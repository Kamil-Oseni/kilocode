import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { z } from "zod"

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
const base = z.object({
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
})
const exact = (value: z.infer<typeof base>) =>
  value.asset.size === value.artifact.size && value.asset.digest.slice("sha256:".length) === value.artifact.digest
const request = base.refine(exact, "The retained package receipt does not match the release asset.")
const record = base
  .extend({ phase: z.enum(["installing", "awaiting-reload"]) })
  .refine(exact, "The retained package receipt does not match the release asset.")

export type InstallRequest = z.infer<typeof request>
export type InstallRecord = z.infer<typeof record> | z.infer<typeof legacy>
type State = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }

function same(left: InstallRecord, right: InstallRequest) {
  if (!("schema" in left)) return left.version === right.version && left.previous === right.previous
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
    left.artifact.digest === right.artifact.digest &&
    left.artifact.size === right.artifact.size &&
    left.package === right.package
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

  constructor(
    private readonly state: State,
    root?: string,
  ) {
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
        const saved = record.safeParse(parse(raw))
        if (!saved.success)
          throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.")
        return saved.data
      }
    }
    const raw = this.state.get(key)
    if (raw === undefined) return undefined
    const saved = legacy.safeParse(raw)
    if (!saved.success)
      throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.")
    return saved.data
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

  private async clear() {
    await this.state.update(key, undefined)
    if (this.file) await rm(this.file, { force: true })
  }

  run(input: InstallRequest, install: () => Promise<void>) {
    const value = request.parse(input)
    return this.lock(async () => {
      const prior = await this.read()
      if (prior) {
        if (!same(prior, value)) throw new Error("Another Raya update installation owns a different verified package.")
        return { dispatched: false as const, record: prior }
      }
      const installing = record.parse({ ...value, phase: "installing" })
      await this.write(installing)
      await install()
      const complete = record.parse({ ...value, phase: "awaiting-reload" })
      await this.write(complete)
      return { dispatched: true as const, record: complete }
    })
  }

  recover(version: string): Promise<InstallRecord | undefined> {
    return this.lock(async () => {
      const saved = await this.read()
      if (!saved) return undefined
      if (saved.version !== version) return saved
      await this.clear()
      return undefined
    })
  }
}
