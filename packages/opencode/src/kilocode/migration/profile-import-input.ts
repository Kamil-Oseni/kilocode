import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"

const credential = z
  .object({
    password: z.string().refine((value) => Buffer.byteLength(value) >= 12 && Buffer.byteLength(value) <= 1024),
  })
  .strict()

function same(left: BigIntStats, right: BigIntStats) {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    left.mode === right.mode
  )
}

/** Fatal decoding preserves BOM treatment of the original Buffer/string parser. */
export function text(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** One opened file, observed-size allocation plus one growth probe, exact CAS. */
export async function read(file: string, maximum: number) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.length > 4096 || /[\0\r\n]/.test(file))
    throw new Error("Import input requires a bounded absolute path")
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 180 * 1024 * 1024)
    throw new Error("Invalid import input bound")
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum))
    throw new Error("Import input is not a bounded unique regular file")
  const physical = await realpath(file)
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  const handle = await open(physical, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!same(before, opened)) throw new Error("Import input changed before reading")
    const size = Number(opened.size)
    const buffer = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const ended = await handle.stat({ bigint: true })
    const current = await lstat(file, { bigint: true })
    if (offset !== size || !same(opened, ended) || !same(opened, current))
      throw new Error("Import input changed during reading")
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Bounded private stdin; no secret appears in a diagnostic or argv. */
export async function secret(input: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new Error("Import stdin exceeded bound")
    chunks.push(bytes)
  }
  return credential.parse(JSON.parse(text(Buffer.concat(chunks)))).password
}
