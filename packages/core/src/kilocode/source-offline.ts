import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { realpath, lstat, mkdtemp, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { inspect, NativeProcess } from "./process-host"
import { validatePolicy, type SourcePolicy } from "./source-policy"
import { plan, negative } from "./source-image-plan"
import { preparation } from "./source-offline-frame"
import { directoryInventory, validateDirectoryInventory } from "./source-image-directories"

type Root = Readonly<{ kind: "json" | "sqlite"; path: string }>
type Pin = Readonly<{ executable: string; digest: string }>
const file = z.string().min(1).max(4096)
const mapping = z
  .object({ kind: z.enum(["json", "sqlite", "negative"]), original: file, staged: file, directory: z.boolean() })
  .strict()
const record = z
  .object({
    original: file,
    staged: file,
    volume: z.number().int().nonnegative(),
    index: z.string().regex(/^\d+$/),
    bytes: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    modified: z
      .string()
      .max(20)
      .regex(/^\d+$/)
      .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
      .optional(),
  })
  .strict()
const identity = z
  .object({
    pid: z.number().int().positive(),
    birth: z.string().regex(/^\d+$/),
    executable: file,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const held = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    generation: z.string().uuid(),
    state: z.literal("held"),
    roots: z.array(mapping).min(1).max(128),
    files: z.array(record).max(16384),
    directories: directoryInventory.optional(),
    guardian: identity,
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
const retired = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    generation: z.string().uuid(),
    state: z.literal("retired"),
    restored: z.literal(true),
    failures: z.array(z.string()).max(16384),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
type Value = Readonly<{
  control: string
  roots: readonly Readonly<
    Omit<z.infer<typeof mapping>, "kind"> & { kind: Root["kind"]; absence?: Awaited<ReturnType<typeof negative>> }
  >[]
  files: readonly Readonly<z.infer<typeof record>>[]
  directories?: Awaited<ReturnType<typeof validateDirectoryInventory>>
  portableCaptureAuthorized: false
}>
const brand: unique symbol = Symbol("held-profile-image")
export type Image = Readonly<{ [brand]: true }>
const images = new WeakMap<object, { roots: readonly Root[]; value: Value; active: boolean }>()
const normalize = (value: string) => value.toLowerCase()
const hash = async (value: string) => {
  const digest = createHash("sha256")
  for await (const bytes of createReadStream(value, { highWaterMark: 65536 })) digest.update(bytes)
  return digest.digest("hex")
}
const same = (left: string, right: string) => normalize(left) === normalize(right)
function inside(root: string, value: string) {
  const relative = path.relative(normalize(root), normalize(value))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
async function canonical(file: string): Promise<string> {
  return realpath(file).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file) throw err
    return path.join(await canonical(path.dirname(file)), path.basename(file))
  })
}
function frame(...values: (number | string)[]) {
  const body = Buffer.concat(
    values.map((value) => {
      const size = Buffer.alloc(4)
      if (typeof value === "number") {
        size.writeUInt32LE(value)
        return size
      }
      size.writeUInt32LE(value.length)
      return Buffer.concat([size, Buffer.from(value, "utf16le")])
    }),
  )
  if (body.length > 32768) throw new Error("Offline control frame exceeded bound")
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length)
  return Buffer.concat([size, body])
}
async function parent(pin: Pin) {
  const executable = await realpath(pin.executable)
  if (!same(executable, pin.executable) || (await hash(executable)) !== pin.digest)
    throw new Error("Offline helper pin changed")
  const row = await inspect(process.pid, executable)
  const schema = z.object({ birth: z.string().regex(/^\d+$/) }).passthrough()
  const owner = schema.parse(row)
  const source = await realpath(process.execPath)
  return { executable, owner: [process.pid, owner.birth, source, await hash(source)] as const }
}
function channel(executable: string) {
  const child = spawn(executable, ["profile-offline"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const errors: Buffer[] = []
  const lines: unknown[] = []
  const pending: { resolve: (value: unknown) => void; reject: (err: unknown) => void }[] = []
  const state = { buffered: "", size: 0, ended: false, code: null as number | null }
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => {
      state.ended = true
      state.code = code
      for (const waiter of pending.splice(0))
        waiter.reject(new Error(`Offline guardian closed ${code}/${signal}: ${Buffer.concat(errors).toString()}`))
      resolve(code)
    })
  })
  child.stderr.on("data", (bytes: Buffer) => {
    if (errors.reduce((size, value) => size + value.length, 0) < 8192) errors.push(bytes)
  })
  child.stdin.on("error", (err) => {
    errors.push(Buffer.from(String(err)))
  })
  child.stdout.on("data", (bytes: Buffer) => {
    state.size += bytes.length
    if (state.size > 16 * 1024 * 1024) {
      for (const waiter of pending.splice(0)) waiter.reject(new Error("Offline response exceeded bound"))
      child.stdin.destroy()
      return
    }
    state.buffered += bytes.toString("utf8")
    while (state.buffered.includes("\n")) {
      const end = state.buffered.indexOf("\n")
      const text = state.buffered.slice(0, end)
      state.buffered = state.buffered.slice(end + 1)
      try {
        const value: unknown = JSON.parse(text)
        const waiter = pending.shift()
        if (waiter) waiter.resolve(value)
        else lines.push(value)
      } catch (err) {
        for (const waiter of pending.splice(0)) waiter.reject(err)
        child.stdin.destroy()
      }
    }
  })
  return {
    child,
    exit,
    next: () =>
      lines.length
        ? Promise.resolve(lines.shift())
        : state.ended
          ? Promise.reject(new Error(`Offline guardian closed ${state.code}`))
          : new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject })),
  }
}
/** An observation or serialized object cannot replace this callback-lifetime token. */
export function assertImage(image: unknown, roots: readonly Root[]): Value {
  if (typeof image !== "object" || image === null) throw new Error("Offline image is not live")
  const state = images.get(image)
  if (
    !state?.active ||
    roots.length !== state.roots.length ||
    roots.some((root, index) => root.kind !== state.roots[index].kind || !same(root.path, state.roots[index].path))
  )
    throw new Error("Offline image is expired or bound to different roots")
  return state.value
}
export function registry(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "win32" || !env.LOCALAPPDATA)
    throw new Error("Offline stable registry requires Windows LOCALAPPDATA")
  return path.join(env.LOCALAPPDATA, "Raya", "offline-recovery")
}
async function protect(directory: string, pin: Pin) {
  const helper = await parent(pin)
  const owner = channel(helper.executable)
  const generation = randomUUID()
  owner.child.stdin.end(frame(1, 2, ...helper.owner, directory, generation))
  z.object({ private: z.literal(true), generation: z.literal(generation) })
    .strict()
    .parse(await owner.next())
  if ((await owner.exit) !== 0) throw new Error("Offline private registry ACL refused")
}
export async function withImage<A>(
  input: {
    roots: readonly Root[]
    policy: SourcePolicy
    helper: Pin
    registry: string
    control?: string
    timeout?: number
    nodes?: number
    bytes?: number
    inventory?: "legacy" | "directories" | "timestamps"
  },
  body: (image: Image) => Promise<A>,
): Promise<A> {
  if (process.platform !== "win32") throw new Error("Offline native platform unsupported")
  const policy = await validatePolicy(input.policy)
  const roots = Object.freeze(
    input.roots.map((root) => Object.freeze({ kind: z.enum(["json", "sqlite"]).parse(root.kind), path: root.path })),
  )
  if (!roots.length || roots.length > 128 || new Set(roots.map((root) => normalize(root.path))).size !== roots.length)
    throw new Error("Offline roots empty, duplicate or exceeded bound")
  const selected = await plan(roots, policy)
  if (selected.roots.length > 128) throw new Error("Offline physical plan exceeded root bound")
  // A stable, explicitly selected registry makes pending recovery discoverable before profile startup.
  if (!path.isAbsolute(input.registry) || !same(path.normalize(input.registry), input.registry))
    throw new Error("Offline registry path invalid")
  if (!same(await canonical(input.registry), input.registry))
    throw new Error("Offline registry aliases a different physical namespace")
  const branches = new Map<string, { path: string; dev: bigint; ino: bigint }>()
  for (const root of selected.roots) {
    const namespace = (await lstat(root.path)).isDirectory() ? root.path : path.dirname(root.path)
    if (!inside(namespace, input.registry) && !inside(input.registry, namespace)) continue
    if (
      root.kind !== "negative" ||
      !inside(namespace, input.registry) ||
      same(namespace, input.registry) ||
      root.missing.some((file) => inside(file, input.registry) || inside(input.registry, file))
    )
      throw new Error("Offline registry overlaps selected namespace")
    const branch = path.join(namespace, path.relative(namespace, input.registry).split(path.sep)[0])
    const info = await lstat(branch, { bigint: true }).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (!info?.isDirectory() || info.isSymbolicLink() || !same(await realpath(branch), branch))
      throw new Error("Offline registry requires a distinct existing canonical branch")
    for (let file = input.registry; inside(namespace, file); file = path.dirname(file)) {
      const info = await lstat(file, { bigint: true }).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
        throw err
      })
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(file), file))
          throw new Error("Offline registry branch is unsupported")
        branches.set(normalize(file), { path: file, dev: info.dev, ino: info.ino })
      }
      if (same(file, namespace)) break
    }
  }
  const check = async () => {
    for (const branch of branches.values()) {
      const info = await lstat(branch.path, { bigint: true })
      if (info.dev !== branch.dev || info.ino !== branch.ino || !same(await realpath(branch.path), branch.path))
        throw new Error("Offline registry branch changed before native acquisition")
    }
  }
  if (branches.size) {
    // This identity recheck is not a kernel lease before mkdir. Never recursively recreate a known branch.
    await check()
    const base = [...branches.values()]
      .filter((branch) => inside(branch.path, input.registry))
      .sort((left, right) => right.path.length - left.path.length)[0]
    let file = base.path
    for (const name of path.relative(base.path, input.registry).split(path.sep).filter(Boolean)) {
      file = path.join(file, name)
      await mkdir(file)
    }
  } else await mkdir(input.registry, { recursive: true })
  const directory = await realpath(input.registry)
  if (!same(directory, input.registry)) throw new Error("Offline registry physical identity changed")
  await check()
  await protect(directory, input.helper)
  await check()
  const control = await realpath(input.control ?? (await mkdtemp(path.join(directory, "capture-"))))
  if (!inside(directory, control) || same(directory, control))
    throw new Error("Offline control is not a registry generation")
  const helper = await parent(input.helper)
  const generation = randomUUID()
  const owner = channel(helper.executable)
  const timeout = z
    .number()
    .int()
    .min(100)
    .max(300000)
    .parse(input.timeout ?? 120000)
  const nodes = z
    .number()
    .int()
    .min(1)
    .max(16384)
    .parse(input.nodes ?? 16384)
  const bytes = z
    .number()
    .int()
    .min(1)
    .max(0xffffffff)
    .parse(input.bytes ?? 256 * 1024 * 1024)
  const inventory = z.enum(["legacy", "directories", "timestamps"]).parse(input.inventory ?? "timestamps")
  const version =
    inventory === "legacy"
      ? selected.roots.some((root) => root.kind === "negative")
        ? 2
        : 1
      : inventory === "directories"
        ? 3
        : 4
  owner.child.stdin.write(
    frame(
      version,
      0,
      ...helper.owner,
      control,
      generation,
      timeout,
      nodes,
      bytes,
      selected.roots.length,
      ...selected.roots.flatMap((root) => [
        root.kind === "negative" ? 2 : root.kind === "sqlite" ? 1 : 0,
        root.path,
        ...(version >= 2 ? [root.missing.length, ...root.missing] : []),
      ]),
    ),
  )
  const failures: unknown[] = []
  const result: { outcome?: { value: A } } = {}
  const token: Image = Object.freeze({ [brand]: true as const })
  try {
    const receipt = held.parse(preparation(await owner.next(), generation, version))
    await check()
    const guardian = z
      .object({ birth: z.string() })
      .passthrough()
      .parse(await inspect(receipt.guardian.pid, helper.executable))
    if (
      guardian.birth !== receipt.guardian.birth ||
      !same(receipt.guardian.executable, helper.executable) ||
      receipt.guardian.digest !== input.helper.digest ||
      (await hash(helper.executable)) !== input.helper.digest
    )
      throw new Error("Offline held guardian identity differs")
    if (
      receipt.version !== version ||
      receipt.generation !== generation ||
      receipt.roots.length !== selected.roots.length ||
      receipt.roots.some(
        (root, index) =>
          root.kind !== selected.roots[index].kind ||
          !same(root.original, selected.roots[index].path) ||
          !inside(control, root.staged),
      )
    )
      throw new Error("Offline held mapping differs")
    for (const entry of receipt.files) {
      if (!inside(control, entry.staged)) throw new Error("Offline stage content differs")
      if ((receipt.version === 4) !== (entry.modified !== undefined))
        throw new Error("Offline timestamp inventory protocol differs")
      if (
        entry.modified !== undefined &&
        (await lstat(entry.staged, { bigint: true })).mtimeNs !== (BigInt(entry.modified) - 116444736000000000n) * 100n
      )
        throw new Error("Offline stage timestamp differs")
      if ((await hash(entry.staged)) !== entry.digest || (await lstat(entry.staged)).size !== entry.bytes)
        throw new Error("Offline stage content differs")
    }
    const indexed = receipt.version >= 3
    if (indexed !== (receipt.directories !== undefined)) throw new Error("Offline directory inventory protocol differs")
    const directories = indexed
      ? await validateDirectoryInventory(receipt.roots, receipt.files, receipt.directories)
      : undefined
    const logical = await Promise.all(
      selected.entries.map(async (entry) => {
        const index = selected.roots.findIndex((root) =>
          entry.missing.length
            ? root.kind === "negative" && same(root.path, entry.namespace) && root.missing.includes(entry.root.path)
            : root.kind === entry.root.kind &&
              (same(root.path, entry.root.path) || (root.kind === "json" && inside(root.path, entry.root.path))),
        )
        const held = receipt.roots[index]
        if (!held) throw new Error("Offline logical root lacks held namespace mapping")
        if (!entry.missing.length) {
          const info = await lstat(entry.root.path, { bigint: true })
          if (info.dev !== entry.dev || info.ino !== entry.ino)
            throw new Error("Offline logical source identity changed")
          return Object.freeze({
            kind: entry.root.kind,
            original: entry.root.path,
            staged: path.join(held.staged, path.relative(held.original, entry.root.path)),
            directory: entry.directory,
          })
        }
        if (!held.directory) throw new Error("Offline negative root namespace is not a directory")
        const absence = await negative(entry, held.staged)
        return Object.freeze({
          kind: entry.root.kind,
          original: entry.root.path,
          staged: held.staged,
          directory: true,
          absence,
        })
      }),
    )
    const value: Value = Object.freeze({
      control,
      roots: Object.freeze(logical),
      files: Object.freeze(receipt.files.map((file) => Object.freeze(file))),
      directories,
      portableCaptureAuthorized: false,
    })
    const state = { roots, value, active: true }
    images.set(token, state)
    void owner.exit.then(
      () => {
        state.active = false
      },
      () => {
        state.active = false
      },
    )
    try {
      result.outcome = { value: await body(token) }
    } finally {
      state.active = false
    }
  } catch (err) {
    failures.push(err)
  }
  // Do not kill on callback failure. The held guardian owns exact rollback.
  if (!owner.child.stdin.destroyed) owner.child.stdin.end(frame(1, generation))
  try {
    const receipt = retired.parse(await owner.next())
    if (receipt.version !== version || receipt.generation !== generation || receipt.failures.length)
      throw new Error(`Offline retirement refused: ${receipt.failures.join("; ")}`)
  } catch (err) {
    failures.push(err)
  }
  const code = await owner.exit
  if (code !== 0) failures.push(new Error(`Offline guardian native exit ${code}`))
  if (failures.length) throw new AggregateError(failures, "Offline image/rollback refused")
  if (!result.outcome) throw new Error("Offline image callback outcome is unavailable")
  return result.outcome.value
}
/** Explicit journal recovery never initializes Global or realizes source graphs. */
export async function recover(control: string, pin: Pin) {
  const helper = await parent(pin)
  const owner = channel(helper.executable)
  const generation = randomUUID()
  owner.child.stdin.end(frame(1, 1, ...helper.owner, await realpath(control), generation))
  const receipt = z
    .object({ recovered: z.literal(true), generation: z.literal(generation) })
    .strict()
    .parse(await owner.next())
  if ((await owner.exit) !== 0) throw new Error("Offline recovery native failure")
  return Object.freeze(receipt)
}
/** Run before profile planning/Global. No missing journal is a capture certificate. */
export async function recoverPending(directory: string, pin: Pin) {
  const info = await lstat(directory).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!info) return Object.freeze([])
  if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(directory), directory))
    throw new Error("Offline recovery registry changed")
  await protect(directory, pin)
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > 1024) throw new Error("Offline recovery registry exceeded bound")
  const receipts: Readonly<{ recovered: true; generation: string }>[] = []
  for (const entry of entries) {
    if (!/^capture-[a-zA-Z0-9]+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Offline recovery registry contains unknown entry")
    receipts.push(await recover(path.join(directory, entry.name), pin))
  }
  return Object.freeze(receipts)
}
/** Must precede SourceProfile.prepare/Global. Missing registry realizes no helper. */
export async function startup(input: { registry?: string; helper?: Pin; env?: NodeJS.ProcessEnv } = {}) {
  if (process.platform !== "win32") return Object.freeze([])
  const directory = input.registry ?? registry(input.env)
  const info = await lstat(directory).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!info) return Object.freeze([])
  const file = input.helper?.executable ?? (await NativeProcess.source())
  const pin = input.helper ?? { executable: file, digest: await hash(file) }
  return recoverPending(directory, pin)
}
