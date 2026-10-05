import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { assertWorking, lookup, type Working } from "./profile-image"

const sum = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    const parts = value.split("/")
    return (
      parts.length <= 32 &&
      !value.includes("\\") &&
      parts.every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          !/[\0-\x1f<>:"|?*]/.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          part.toLowerCase() !== ".git",
      )
    )
  })
const baseline = z
  .object({
    path: relative,
    digest: hash,
    mode: z.union([z.literal(420), z.literal(493)]),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
  })
  .strict()
const snapshot = z
  .object({ version: z.literal(1), digest: hash, head: z.string().max(256), files: z.array(baseline).max(10_000) })
  .strict()
  .superRefine((value, ctx) => {
    if (sum(JSON.stringify({ head: value.head, files: value.files })) !== value.digest)
      ctx.addIssue({ code: "custom", message: "Verification snapshot identity differs" })
  })
const file = z
  .object({
    path: relative,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    digest: hash,
    mode: z.union([z.literal(420), z.literal(493)]),
    data: z.string().max(90 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      supported(value.path)
    } catch {
      ctx.addIssue({ code: "custom", message: "Unsupported private verification checkout content" })
    }
    if (value.bytes > 64 * 1024 * 1024 || value.data.length > 90 * 1024 * 1024) {
      ctx.addIssue({ code: "custom", message: "Verification checkout bytes exceed supported bounds" })
      return
    }
    const bytes = Buffer.from(value.data, "base64")
    if (bytes.toString("base64") !== value.data || bytes.length !== value.bytes || sum(bytes) !== value.digest)
      ctx.addIssue({ code: "custom", message: "Verification checkout bytes differ" })
  })
const change = z
  .object({
    path: relative,
    status: z.enum(["unchanged", "modified", "missing", "extra"]),
    baseline: hash.optional(),
    current: hash.optional(),
  })
  .strict()
function changes(before: readonly z.infer<typeof baseline>[], files: readonly z.infer<typeof file>[]) {
  const original = new Map(before.map((file) => [file.path, file]))
  const current = new Map(files.map((file) => [file.path, file]))
  return [...new Set([...original.keys(), ...current.keys()])].sort().map((path) => {
    const old = original.get(path)
    const next = current.get(path)
    return {
      path,
      status: !old
        ? ("extra" as const)
        : !next
          ? ("missing" as const)
          : old.digest === next.digest && old.size === next.bytes && old.mode === next.mode
            ? ("unchanged" as const)
            : ("modified" as const),
      ...(old ? { baseline: old.digest } : {}),
      ...(next ? { current: next.digest } : {}),
    }
  })
}
function inventory(value: {
  original: string
  sources: string[]
  snapshot?: z.infer<typeof snapshot>
  directories: string[]
  files: z.infer<typeof file>[]
  excluded: string[]
}) {
  return sum(JSON.stringify({ ...value, files: value.files.map(({ data: _data, ...file }) => file) }))
}
const checkout = z
  .object({
    version: z.literal(1),
    original: absolute,
    sources: z.array(z.string().min(1).max(8192)).max(10_000),
    snapshot: snapshot.optional(),
    directories: z.array(relative).max(10_000),
    files: z.array(file).max(10_000),
    changes: z.array(change).max(20_000),
    excluded: z.array(z.literal("git-metadata")).max(1),
    digest: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const name of [...value.directories, ...value.files.map((file) => file.path)]) {
      try {
        supported(name)
      } catch {
        ctx.addIssue({ code: "custom", message: "Unsupported verification checkout namespace" })
      }
      if (seen.has(key(name))) ctx.addIssue({ code: "custom", message: "Duplicate verification checkout path" })
      seen.add(key(name))
    }
    const prior = new Set<string>()
    for (const file of value.snapshot?.files ?? []) {
      if (prior.has(key(file.path))) ctx.addIssue({ code: "custom", message: "Duplicate snapshot path" })
      prior.add(key(file.path))
    }
    const { version: _version, changes: _changes, digest: _digest, ...body } = value
    if (
      inventory(body) !== value.digest ||
      JSON.stringify(changes(value.snapshot?.files ?? [], value.files)) !== JSON.stringify(value.changes)
    )
      ctx.addIssue({ code: "custom", message: "Verification checkout inventory differs" })
    if (value.files.reduce((sum, file) => sum + file.bytes, 0) > 64 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Verification checkout exceeds supported bytes" })
  })
export const checkouts = z
  .array(checkout)
  .max(1000)
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const row of value) {
      if (seen.has(key(row.original))) ctx.addIssue({ code: "custom", message: "Duplicate verification checkout" })
      seen.add(key(row.original))
    }
  })

function supported(name: string) {
  relative.parse(name)
  if (
    /(^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.yarnrc(?:\.yml)?|\.git-credentials|\.ssh|id_rsa|id_ed25519|node_modules|\.kilo|\.opencode)(?:\/|$)/i.test(
      name,
    ) &&
    !/\.(example|sample|template)$/i.test(name)
  )
    throw new Error("Verification checkout contains unsupported private or control material")
}
/** No live source reads: only a producer-declared directory copied under the held image. */
export async function collectCheckout(token: Working, original: string, sources: string[], prior?: unknown) {
  const baseline = prior === undefined ? undefined : snapshot.parse(prior)
  const scope = assertWorking(token)
  const root = scope.original
    .filter(
      (root) =>
        root.kind === "json" &&
        (key(original) === key(root.path) || key(original).startsWith(key(root.path + path.sep))),
    )
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!root) throw new Error("Verification checkout lacks held namespace")
  const directory = path.join(lookup(token, root.path), path.relative(root.path, absolute.parse(original)))
  const directories: string[] = []
  const entries: { path: string; bytes: number; mode: 420 | 493 }[] = []
  const excluded: "git-metadata"[] = []
  const budget = { bytes: 0, count: 0 }
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    assertWorking(token)
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(dir)) !== key(dir) || depth > 32)
      throw new Error("Unsupported verification checkout directory")
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name
      if (!prefix && item.name === ".git") {
        const git = await lstat(path.join(dir, item.name))
        if (
          !git.isDirectory() ||
          git.isSymbolicLink() ||
          key(await realpath(path.join(dir, item.name))) !== key(path.join(dir, item.name))
        )
          throw new Error("Unsupported verification Git metadata")
        excluded.push("git-metadata")
        continue
      }
      supported(name)
      if (++budget.count > 10_000) throw new Error("Verification checkout exceeds supported count")
      if (item.isSymbolicLink()) throw new Error("Aliased verification checkout entry")
      if (item.isDirectory()) {
        directories.push(name)
        await walk(path.join(dir, item.name), name + "/", depth + 1)
        continue
      }
      const stat = await lstat(path.join(dir, item.name))
      if (!item.isFile() || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
        throw new Error("Unsupported verification checkout file")
      budget.bytes += stat.size
      if (budget.bytes > 64 * 1024 * 1024) throw new Error("Verification checkout exceeds supported bytes")
      entries.push({ path: name, bytes: stat.size, mode: stat.mode & 0o111 ? 493 : 420 })
    }
  }
  await walk(directory, "", 0)
  const files: z.infer<typeof file>[] = []
  for (const entry of entries) {
    assertWorking(token)
    const name = path.join(directory, ...entry.path.split("/"))
    const stat = await lstat(name)
    const fd = await open(name, "r")
    try {
      const before = await fd.stat()
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== entry.bytes ||
        before.dev !== stat.dev ||
        before.ino !== stat.ino ||
        key(await realpath(name)) !== key(name)
      )
        throw new Error("Verification checkout changed before read")
      const data = Buffer.alloc(before.size)
      if ((await fd.read(data, 0, data.length, 0)).bytesRead !== data.length)
        throw new Error("Incomplete verification checkout read")
      const after = await fd.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error("Verification checkout changed during read")
      files.push(file.parse({ ...entry, data: data.toString("base64"), digest: sum(data) }))
    } finally {
      await fd.close()
    }
  }
  assertWorking(token)
  const body = {
    original,
    sources: [...new Set(sources)].sort(),
    ...(baseline ? { snapshot: baseline } : {}),
    directories: directories.sort(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    excluded,
  }
  return checkout.parse({
    version: 1,
    ...body,
    changes: changes(baseline?.files ?? [], body.files),
    digest: inventory(body),
  })
}

/** Restore retained bytes only as inactive lineage; original execution paths are never recreated. */
export async function restoreCheckouts(rows: z.infer<typeof checkouts>, data: string) {
  const seen = new Set<string>()
  for (const row of z.array(checkout).max(33_000).parse(rows)) {
    const id = sum(row.original + "\0" + row.digest)
    if (seen.has(id)) continue
    seen.add(id)
    const root = path.join(data, "restore-self-heal-checkouts", id)
    await mkdir(root, { recursive: true })
    for (const dir of row.directories) await mkdir(path.join(root, "tree", ...dir.split("/")), { recursive: true })
    for (const file of row.files) {
      const target = path.join(root, "tree", ...file.path.split("/"))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: file.mode })
    }
    await writeFile(path.join(root, "inventory.json"), JSON.stringify(row), { flag: "wx" })
  }
}
