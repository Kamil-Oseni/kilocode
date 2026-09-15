import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
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
const schema = z
  .object({
    version: z.literal(1),
    active: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    packages: z.array(entry).max(8),
  })
  .superRefine((value, ctx) => {
    const digests = new Set<string>()
    const paths = new Set<string>()
    value.packages.forEach((item, index) => {
      if (digests.has(item.artifact.digest))
        ctx.addIssue({ code: "custom", message: "Duplicate package digest.", path: ["packages", index] })
      if (paths.has(item.package))
        ctx.addIssue({ code: "custom", message: "Duplicate package path.", path: ["packages", index] })
      digests.add(item.artifact.digest)
      paths.add(item.package)
    })
  })

export type Package = z.infer<typeof entry>

export class PackageVault {
  private readonly file: string
  private readonly locks: string

  constructor(
    private readonly root: string,
    private readonly barrier?: (phase: "retain" | "activate") => Promise<void>,
  ) {
    this.file = join(root, "packages.json")
    this.locks = join(root, ".locks")
  }

  private lock<T>(work: () => Promise<T>) {
    return Flock.withLock("raya-package-vault", work, { dir: this.locks, staleMs: 60_000, timeoutMs: 120_000 })
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
      const root = resolve(this.root)
      const safe = (value: Package) => {
        const path = resolve(value.package)
        const nested = relative(root, path)
        const expected = `raya.${value.artifact.digest}.vsix`
        if (!nested || nested.startsWith("..") || isAbsolute(nested) || basename(path) !== expected)
          throw new Error(`Refusing to reconcile a package outside ${root}.`)
        return path
      }
      const checked = await Promise.all(
        saved.packages.map(async (value) => {
          const path = safe(value)
          const exists = await stat(path).then(
            (info) => info.isFile(),
            (err: NodeJS.ErrnoException) => {
              if (err.code === "ENOENT") return false
              throw err
            },
          )
          if (!exists && saved.active === value.artifact.digest)
            throw new Error("The Raya package vault active package file is missing.")
          return { value, exists }
        }),
      )
      const missing = checked.filter((item) => !item.exists).map((item) => item.value)
      const present = checked.filter((item) => item.exists).map((item) => item.value)
      const snapshots = present
        .filter((value) => value.version.includes("-snapshot+"))
        .sort((a, b) => b.retainedAt - a.retainedAt)
      const keep = new Set(snapshots.slice(0, input?.retained ?? 2).map((value) => value.artifact.digest))
      if (saved.active) keep.add(saved.active)
      for (const digest of input?.keep ?? []) keep.add(digest)
      const stale = snapshots.filter((value) => !keep.has(value.artifact.digest))
      const removed = new Set([...missing, ...stale].map((value) => value.artifact.digest))
      const packages = saved.packages.filter((value) => !removed.has(value.artifact.digest))
      if (removed.size) await this.write({ ...saved, packages })
      await Promise.all(stale.map((value) => rm(value.package, { force: true })))
      const indexed = new Set(packages.map((value) => resolve(value.package)))
      const files = await readdir(this.root, { withFileTypes: true })
      const orphans = files
        .filter((file) => file.isFile() && /^raya\.[a-f0-9]{64}\.vsix$/.test(file.name))
        .map((file) => join(this.root, file.name))
        .filter((path) => !indexed.has(resolve(path)))
      const sizes = await Promise.all(orphans.map(async (path) => (await stat(path)).size))
      await Promise.all(orphans.map((path) => rm(path)))
      return {
        packages: removed.size + orphans.length,
        bytes: stale.reduce((total, value) => total + value.artifact.size, 0) + sizes.reduce((a, b) => a + b, 0),
      }
    })
  }

  async retain(source: string, identity: PackageIdentity) {
    const receipt = await inspect(source, identity)
    await mkdir(this.root, { recursive: true })
    const path = join(this.root, `raya.${receipt.artifact.digest}.vsix`)
    const tmp = join(this.root, `raya.${receipt.artifact.digest}.${randomUUID()}.tmp`)
    const value: Package = {
      version: identity.version,
      target: identity.target,
      package: path,
      ...receipt,
      retainedAt: Date.now(),
    }
    const matches = (found: Package) =>
      found.version === value.version &&
      found.target === value.target &&
      found.package === value.package &&
      found.artifact.digest === value.artifact.digest &&
      found.artifact.size === value.artifact.size &&
      found.binary.digest === value.binary.digest &&
      found.binary.size === value.binary.size
    try {
      await copyFile(source, tmp, constants.COPYFILE_EXCL)
      const file = await open(tmp, "r+")
      try {
        await file.sync()
      } finally {
        await file.close()
      }
      await verify(tmp, { ...identity, ...receipt })
      await this.barrier?.("retain")
      const result = await this.lock(async () => {
        const saved = await this.read()
        const found = saved.packages.find((item) => item.artifact.digest === receipt.artifact.digest)
        if (found) {
          if (!matches(found)) throw new Error("The Raya package vault contains conflicting package metadata.")
          return { kind: "existing" as const, value: found }
        }
        if (saved.packages.length >= 8)
          throw new Error("The Raya package vault is full; review retained packages first.")
        const linked = await link(tmp, path).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code === "EEXIST") return false
            throw err
          },
        )
        if (!linked) return { kind: "orphan" as const }
        await this.write({ ...saved, packages: [...saved.packages, value] })
        return { kind: "saved" as const, value }
      })
      if (result.kind !== "orphan") {
        await verify(result.value.package, { ...identity, ...receipt })
        return result.value
      }
      await verify(path, { ...identity, ...receipt })
      return this.lock(async () => {
        const saved = await this.read()
        const found = saved.packages.find((item) => item.artifact.digest === receipt.artifact.digest)
        if (found) {
          if (!matches(found)) throw new Error("The Raya package vault contains conflicting package metadata.")
          return found
        }
        if (saved.packages.length >= 8)
          throw new Error("The Raya package vault is full; review retained packages first.")
        const info = await stat(path).then(
          (item) => item,
          (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") throw new Error("The verified Raya package orphan no longer exists.")
            throw err
          },
        )
        if (!info.isFile() || info.size !== receipt.artifact.size)
          throw new Error("The verified Raya package orphan changed before it could be indexed.")
        await this.write({ ...saved, packages: [...saved.packages, value] })
        return value
      })
    } finally {
      await rm(tmp, { force: true })
    }
  }

  async activate(version: string, target: string, binary: string) {
    const candidate = await this.lock(async () => {
      const saved = await this.read()
      const matches = saved.packages.filter((value) => value.version === version && value.target === target)
      if (!matches.length) return
      if (matches.length !== 1) throw new Error("The Raya package vault has ambiguous active-version packages.")
      return matches[0]
    })
    if (!candidate) return
    await verify(candidate.package, { name: "raya", publisher: "eden", ...candidate })
    await checksum(binary, candidate.binary, 512 * 1024 * 1024)
    await this.barrier?.("activate")
    return this.lock(async () => {
      const saved = await this.read()
      const matches = saved.packages.filter((value) => value.version === version && value.target === target)
      if (matches.length !== 1 || matches[0].artifact.digest !== candidate.artifact.digest)
        throw new Error("The Raya package vault changed while activation was being verified.")
      const value = matches[0]
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
