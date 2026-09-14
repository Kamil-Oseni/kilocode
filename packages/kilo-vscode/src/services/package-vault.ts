import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { z } from "zod"
import { checksum, inspect, verify, type PackageIdentity } from "./update-vsix"

const bytes = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })
const entry = z.object({
  version: z.string().min(1),
  target: z.string().min(1),
  package: z.string().min(1),
  artifact: bytes,
  binary: bytes,
  retainedAt: z.number().finite().nonnegative(),
})
const schema = z.object({
  version: z.literal(1),
  active: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  packages: z.array(entry).max(8),
})

export type Package = z.infer<typeof entry>

export class PackageVault {
  private readonly file: string
  private readonly locks: string

  constructor(private readonly root: string) {
    this.file = join(root, "packages.json")
    this.locks = join(root, ".locks")
  }

  private lock<T>(work: () => Promise<T>) {
    return Flock.withLock("raya-package-vault", work, { dir: this.locks, staleMs: 2_000, timeoutMs: 30_000 })
  }

  private async read() {
    const raw = await readFile(this.file, "utf8").then(
      (value) => value,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw err
      },
    )
    if (raw === undefined) return { version: 1 as const, packages: [] }
    const saved = schema.safeParse(JSON.parse(raw))
    if (!saved.success) throw new Error("The Raya package vault index is invalid and was retained.")
    return saved.data
  }

  private async write(value: z.infer<typeof schema>) {
    await mkdir(this.root, { recursive: true })
    const tmp = join(this.root, `packages.${process.pid}.${randomUUID()}.tmp`)
    const file = await open(tmp, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, this.file)
  }

  pruneSnapshots(input?: { keep?: readonly string[]; retained?: number }) {
    return this.lock(async () => {
      const saved = await this.read()
      const snapshots = saved.packages
        .filter((value) => value.version.includes("-snapshot+"))
        .sort((a, b) => b.retainedAt - a.retainedAt)
      const keep = new Set(snapshots.slice(0, input?.retained ?? 2).map((value) => value.artifact.digest))
      if (saved.active) keep.add(saved.active)
      for (const digest of input?.keep ?? []) keep.add(digest)
      const stale = snapshots.filter((value) => !keep.has(value.artifact.digest))
      if (!stale.length) return { packages: 0, bytes: 0 }
      const root = resolve(this.root)
      for (const value of stale) {
        const path = resolve(value.package)
        const nested = relative(root, path)
        const expected = `raya.${value.artifact.digest}.vsix`
        if (!nested || nested.startsWith("..") || isAbsolute(nested) || basename(path) !== expected)
          throw new Error(`Refusing to remove a snapshot package outside ${root}.`)
      }
      const digests = new Set(stale.map((value) => value.artifact.digest))
      await this.write({
        ...saved,
        packages: saved.packages.filter((value) => !digests.has(value.artifact.digest)),
      })
      await Promise.all(stale.map((value) => rm(value.package, { force: true })))
      return {
        packages: stale.length,
        bytes: stale.reduce((total, value) => total + value.artifact.size, 0),
      }
    })
  }

  retain(source: string, identity: PackageIdentity) {
    return this.lock(async () => {
      const receipt = await inspect(source, identity)
      const saved = await this.read()
      const existing = saved.packages.find((value) => value.artifact.digest === receipt.artifact.digest)
      if (existing) {
        await verify(existing.package, { ...identity, ...receipt })
        return existing
      }
      if (saved.packages.length >= 8) throw new Error("The Raya package vault is full; review retained packages first.")
      await mkdir(this.root, { recursive: true })
      const packagePath = join(this.root, `raya.${receipt.artifact.digest}.vsix`)
      const tmp = join(this.root, `raya.${receipt.artifact.digest}.${randomUUID()}.tmp`)
      try {
        await copyFile(source, tmp, constants.COPYFILE_EXCL)
        const file = await open(tmp, "r+")
        try {
          await file.sync()
        } finally {
          await file.close()
        }
        await verify(tmp, { ...identity, ...receipt })
        await rename(tmp, packagePath)
      } finally {
        await rm(tmp, { force: true })
      }
      const value: Package = {
        version: identity.version,
        target: identity.target,
        package: packagePath,
        ...receipt,
        retainedAt: Date.now(),
      }
      await this.write({ ...saved, packages: [...saved.packages, value] })
      return value
    })
  }

  activate(version: string, target: string, binary: string) {
    return this.lock(async () => {
      const saved = await this.read()
      const matches = saved.packages.filter((value) => value.version === version && value.target === target)
      if (!matches.length) return
      if (matches.length !== 1) throw new Error("The Raya package vault has ambiguous active-version packages.")
      const value = matches[0]
      await verify(value.package, { name: "raya", publisher: "eden", ...value })
      await checksum(binary, value.binary, 512 * 1024 * 1024)
      if (saved.active !== value.artifact.digest) await this.write({ ...saved, active: value.artifact.digest })
      return value
    })
  }

  current() {
    return this.lock(async () => {
      const saved = await this.read()
      if (!saved.active) return
      const matches = saved.packages.filter((value) => value.artifact.digest === saved.active)
      if (matches.length !== 1) throw new Error("The Raya package vault active package is missing or ambiguous.")
      return matches[0]
    })
  }
}
