import { createHash, randomUUID } from "node:crypto"
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"

type Binding = Readonly<{
  path: string
  digest: string
  bytes: number
  identity: Readonly<{ dev: string; ino: string }>
}>
export type Predecessor = Readonly<{ predecessor: true }>
export type Publication = Readonly<{ publication: true }>
const predecessors = new WeakMap<Predecessor, { path: string; value?: Binding; used?: boolean }>()
const publications = new WeakMap<
  Publication,
  Readonly<{ predecessor: Predecessor; before?: Binding; after: Binding }>
>()
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const sum = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

async function read(file: string): Promise<Binding | undefined> {
  const first = await lstat(file, { bigint: true }).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (!first) return undefined
  if (!first.isFile() || first.isSymbolicLink() || first.nlink !== 1n)
    throw new Error("Markdown publication source is not a bounded regular file")
  if (key(await realpath(file)) !== key(file)) throw new Error("Markdown publication source is not canonical")
  const bytes = await readFile(file)
  const last = await lstat(file, { bigint: true })
  if (
    first.dev !== last.dev ||
    first.ino !== last.ino ||
    first.size !== last.size ||
    first.mtimeNs !== last.mtimeNs ||
    last.nlink !== 1n ||
    BigInt(bytes.length) !== last.size
  )
    throw new Error("Markdown publication source changed during read")
  return Object.freeze({
    path: file,
    digest: sum(bytes),
    bytes: bytes.length,
    identity: Object.freeze({ dev: String(first.dev), ino: String(first.ino) }),
  })
}
function same(left: Binding | undefined, right: Binding | undefined) {
  return JSON.stringify(left) === JSON.stringify(right)
}
export async function inspect(file: string): Promise<Predecessor> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error("Markdown publication path is invalid")
  const value = await read(file)
  const token = Object.freeze({ predecessor: true as const })
  predecessors.set(token, { path: file, value })
  return token
}
export function binding(token: Predecessor) {
  const value = predecessors.get(token)
  if (!value) throw new Error("Markdown predecessor is unknown")
  return value.value
}
export function publication(token: Publication) {
  const value = publications.get(token)
  if (!value) throw new Error("Markdown publication receipt is unknown")
  return value
}
/** Return authority only for this exclusive temporary file's verified atomic publication. */
export async function publish(file: string, text: string, token: Predecessor, mode = 0o600): Promise<Publication> {
  const before = predecessors.get(token)
  if (!before || before.used || key(before.path) !== key(file))
    throw new Error("Markdown publication predecessor differs")
  before.used = true
  const temporary = path.join(path.dirname(file), `.markdown-${randomUUID()}.pending`)
  const errors: unknown[] = []
  const handle = await open(temporary, "wx", mode)
  let owned = true
  let after: Binding | undefined
  async function cleanup() {
    const current = await lstat(temporary, { bigint: true })
    const held = await handle.stat({ bigint: true })
    if (current.dev !== held.dev || current.ino !== held.ino || !current.isFile() || current.isSymbolicLink())
      throw new Error("Markdown temporary cleanup identity differs")
    await unlink(temporary)
  }
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(Buffer.byteLength(text)))
      throw new Error("Markdown temporary publication identity differs")
    const expected = Object.freeze({
      path: file,
      digest: sum(text),
      bytes: Buffer.byteLength(text),
      identity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }),
    })
    for (let attempt = 1; ; attempt++) {
      if (!same(before.value, await read(file)))
        throw new Error("Markdown publication predecessor changed before rename")
      const temporaryBinding = await read(temporary)
      if (
        !temporaryBinding ||
        temporaryBinding.identity.dev !== expected.identity.dev ||
        temporaryBinding.identity.ino !== expected.identity.ino ||
        temporaryBinding.digest !== expected.digest ||
        temporaryBinding.bytes !== expected.bytes
      )
        throw new Error("Markdown owned temporary file changed")
      try {
        await rename(temporary, file)
        owned = false
        break
      } catch (err) {
        if (
          process.platform !== "win32" ||
          !err ||
          typeof err !== "object" ||
          !("code" in err) ||
          !["EBUSY", "EACCES", "EPERM"].includes(String(err.code)) ||
          attempt >= 8
        )
          throw err
        await Bun.sleep(50 * attempt)
      }
    }
    after = await read(file)
    const final = await handle.stat({ bigint: true })
    if (
      !same(after, expected) ||
      String(final.dev) !== expected.identity.dev ||
      String(final.ino) !== expected.identity.ino ||
      final.nlink !== 1n ||
      final.size !== BigInt(expected.bytes)
    )
      throw new Error("Markdown final publication is not the owned temporary file")
  } catch (err) {
    errors.push(err)
  } finally {
    if (owned)
      await cleanup().catch((err) => {
        errors.push(err)
      })
    await handle.close().catch((err) => {
      errors.push(err)
    })
  }
  if (errors.length || !after) throw new AggregateError(errors, "Markdown atomic publication failed")
  const receipt = Object.freeze({ publication: true as const })
  publications.set(receipt, Object.freeze({ predecessor: token, before: before.value, after }))
  return receipt
}
