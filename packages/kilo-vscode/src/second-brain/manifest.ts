import { lstat, open } from "node:fs/promises"
import { parse } from "./settings"

/** User-selected public metadata only; never a credential or approval authority. */
export async function metadata<T>(file: string, decode: (input: unknown) => T) {
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16_384n)
    throw new Error("Memory setup must be a bounded ordinary file")
  const held = await open(file, "r")
  const result = await (async () => {
    const row = await held.stat({ bigint: true })
    const buffer = Buffer.alloc(16_385)
    const read = await held.read(buffer, 0, buffer.byteLength, 0)
    const bytes = buffer.subarray(0, read.bytesRead)
    const after = await lstat(file, { bigint: true })
    const final = await held.stat({ bigint: true })
    for (const info of [row, after, final])
      if (
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size !== before.size ||
        info.mtimeNs !== before.mtimeNs ||
        info.nlink !== 1n
      )
        throw new Error("Memory setup changed during import")
    if (before.ctimeNs !== after.ctimeNs || row.ctimeNs !== final.ctimeNs || bytes.byteLength !== Number(before.size))
      throw new Error("Memory setup changed during import")
    return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  })().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  const cleanup = await held.close().then(
    () => undefined,
    (error: unknown) => error,
  )
  if ("error" in result) {
    if (cleanup !== undefined) throw new AggregateError([result.error, cleanup], "Memory import and cleanup failed")
    throw result.error
  }
  if (cleanup !== undefined) throw cleanup
  return result.value
}

export const manifest = (file: string) => metadata(file, parse)
