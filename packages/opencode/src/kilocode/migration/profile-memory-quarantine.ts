import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import path from "node:path"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { quarantine, quarantineName } from "./profile-memory-quarantine-schema"

const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const same = (one: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, two: typeof one) =>
  one.dev === two.dev &&
  one.ino === two.ino &&
  one.size === two.size &&
  one.mtimeNs === two.mtimeNs &&
  one.ctimeNs === two.ctimeNs

/** Validated original bytes only. Genuine capture authority belongs to the future Working-bound caller. */
export async function readQuarantine(dir: string, input: { source: string; workspace: string }) {
  if (![dir, input.source, input.workspace].every((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file)))
    throw new Error("Memory quarantine requires absolute namespace paths")
  if (path.basename(input.source) !== MemoryPaths.declared(input.workspace).folder)
    throw new Error("Memory quarantine original namespace differs from its workspace")
  const before = await lstat(dir, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink() || key(await realpath(dir)) !== key(dir))
    throw new Error("Memory quarantine namespace is not a canonical regular directory")
  const names = new Set<string>()
  const files: { name: string; info: BigIntStats }[] = []
  let total = 0
  let nodes = 0
  for await (const entry of await opendir(dir)) {
    if (++nodes > 2048) throw new Error("Memory quarantine namespace inventory exceeds its bound")
    if (!entry.name.toLowerCase().startsWith("state.json.bad")) continue
    const name = quarantineName.parse(entry.name)
    if (names.has(name.toLowerCase())) throw new Error("Memory quarantine current filenames collide")
    names.add(name.toLowerCase())
    if (files.length >= 64) throw new Error("Memory quarantine current inventory exceeds its bound")
    const info = await lstat(path.join(dir, name), { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1048576n)
      throw new Error("Memory quarantine source is not a bounded unique regular file")
    total += Number(info.size)
    if (total > 4 * 1048576) throw new Error("Memory quarantine current inventory exceeds its byte bound")
    files.push({ name, info })
  }
  const values = []
  let bytes = 0
  for (const item of files.sort((one, two) => one.name.localeCompare(two.name))) {
    const file = path.join(dir, item.name)
    const handle = await open(file, "r")
    const errors: unknown[] = []
    try {
      const info = await handle.stat({ bigint: true })
      const current = await lstat(file, { bigint: true })
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1n ||
        !same(item.info, info) ||
        !same(info, current)
      )
        throw new Error("Memory quarantine source identity changed before read")
      const buffer = Buffer.alloc(Number(info.size) + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const final = await lstat(file, { bigint: true })
      if (
        offset !== Number(info.size) ||
        !after.isFile() ||
        after.nlink !== 1n ||
        !final.isFile() ||
        final.isSymbolicLink() ||
        final.nlink !== 1n ||
        !same(info, after) ||
        !same(info, final)
      )
        throw new Error("Memory quarantine source identity changed during read")
      const raw = buffer.subarray(0, offset)
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
      if (!Buffer.from(text, "utf8").equals(raw)) throw new Error("Memory quarantine UTF8 bytes do not round trip")
      bytes += raw.length
      if (bytes > 4 * 1048576) throw new Error("Memory quarantine read exceeds its byte bound")
      values.push({
        source: path.join(input.source, item.name),
        workspace: input.workspace,
        name: item.name,
        text,
        bytes: raw.length,
        digest: createHash("sha256").update(raw).digest("hex"),
        activation: "inert" as const,
      })
    } catch (err) {
      errors.push(err)
    } finally {
      await handle.close().catch((err: unknown) => errors.push(err))
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Memory quarantine read and handle cleanup failed")
  }
  const after = await lstat(dir, { bigint: true })
  if (!after.isDirectory() || after.isSymbolicLink() || !same(before, after) || key(await realpath(dir)) !== key(dir))
    throw new Error("Memory quarantine namespace identity changed during inventory")
  return quarantine.parse(values)
}
