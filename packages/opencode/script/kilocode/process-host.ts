import { createHash } from "node:crypto"
import { copyFile, mkdir, open, rm } from "node:fs/promises"
import path from "node:path"

const core = path.resolve(import.meta.dirname, "../../../core")
const script = path.join(core, "script/kilocode/build-process-host.ps1")
const inputs = [
  path.join(core, "native/kilocode/process-host.cpp"),
  path.join(core, "native/kilocode/source-host.inc"),
  path.join(core, "native/kilocode/source-diagnostic.inc"),
  path.join(core, "native/kilocode/source-pipe.inc"),
  path.join(core, "native/kilocode/profile-offline.inc"),
  script,
]
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
async function bytes(file: string, max: number) {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(max + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size > max) throw new Error("Native process helper artifact exceeds its size limit")
    return buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
}
export async function recipe() {
  const parts = await Promise.all(inputs.map((file) => bytes(file, 2 * 1024 * 1024)))
  const hash = createHash("sha256")
  for (const [index, part] of parts.entries())
    hash.update(path.relative(core, inputs[index]).replaceAll("\\", "/")).update("\0").update(part).update("\0")
  return hash.digest("hex")
}
function slice(data: Buffer, offset: number, size: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > data.length
  )
    throw new Error("Native process helper debug identity is incomplete")
  return data.subarray(offset, offset + size)
}
function symbols(exe: Buffer, pdb: Buffer) {
  if (slice(exe, 0, 2).toString() !== "MZ") throw new Error("Native process helper is not a Windows executable")
  const pe = slice(exe, 60, 4).readUInt32LE()
  if (slice(exe, pe, 4).toString("hex") !== "50450000" || slice(exe, pe + 4, 2).readUInt16LE() !== 0x8664)
    throw new Error("Native process helper architecture must be Windows x64")
  const count = slice(exe, pe + 6, 2).readUInt16LE()
  const optional = pe + 24
  const length = slice(exe, pe + 20, 2).readUInt16LE()
  if (count > 96 || length < 168 || slice(exe, optional, 2).readUInt16LE() !== 0x20b)
    throw new Error("Native process helper PE headers are invalid")
  const sections = optional + length
  const offset = (rva: number, size: number) => {
    for (let index = 0; index < count; index++) {
      const section = slice(exe, sections + index * 40, 40)
      const start = section.readUInt32LE(12)
      const length = section.readUInt32LE(16)
      if (rva < start || rva - start + size > length) continue
      return section.readUInt32LE(20) + rva - start
    }
    throw new Error("Native process helper debug directory is invalid")
  }
  const debug = slice(exe, optional + 160, 8)
  const size = debug.readUInt32LE(4)
  if (!size || size > 4096 || size % 28) throw new Error("Native process helper has no bounded debug directory")
  const rows = slice(exe, offset(debug.readUInt32LE(), size), size)
  const identities: Buffer[] = []
  for (let index = 0; index < size; index += 28) {
    const row = rows.subarray(index, index + 28)
    if (row.readUInt32LE(12) !== 2) continue
    const data = slice(exe, row.readUInt32LE(24), row.readUInt32LE(16))
    if (data.length < 24 || data.subarray(0, 4).toString() !== "RSDS")
      throw new Error("Native process helper CodeView identity is invalid")
    identities.push(data.subarray(4, 24))
  }
  if (identities.length !== 1) throw new Error("Native process helper has no unique symbols identity")
  if (slice(pdb, 0, 32).toString("hex") !== Buffer.from("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0").toString("hex"))
    throw new Error("Native process helper symbols are not an MSF7 PDB")
  const block = slice(pdb, 32, 4).readUInt32LE()
  const total = slice(pdb, 44, 4).readUInt32LE()
  const map = slice(pdb, 52, 4).readUInt32LE()
  if (![512, 1024, 2048, 4096].includes(block) || !total || total > 1024 * 1024)
    throw new Error("Native process helper PDB directory exceeds its limit")
  const blocks = Math.ceil(total / block)
  if (blocks * 4 > block) throw new Error("Native process helper PDB block map is invalid")
  const table = slice(pdb, map * block, blocks * 4)
  const directory = Buffer.concat(
    Array.from({ length: blocks }, (_, index) => slice(pdb, table.readUInt32LE(index * 4) * block, block)),
  ).subarray(0, total)
  const streams = slice(directory, 0, 4).readUInt32LE()
  if (streams < 2 || streams > 65536) throw new Error("Native process helper PDB streams exceed their limit")
  const sizes = slice(directory, 4, streams * 4)
  let cursor = 4 + streams * 4
  for (let index = 0; index < streams; index++) {
    const size = sizes.readUInt32LE(index * 4)
    const count = size === 0xffffffff ? 0 : Math.ceil(size / block)
    const entries = slice(directory, cursor, count * 4)
    cursor += count * 4
    if (index !== 1) continue
    if (size < 28 || size > 1024 * 1024) throw new Error("Native process helper PDB information stream is invalid")
    const info = Buffer.concat(
      Array.from({ length: count }, (_, index) => slice(pdb, entries.readUInt32LE(index * 4) * block, block)),
    ).subarray(0, size)
    const identity = identities[0]
    if (!identity.subarray(0, 16).equals(info.subarray(12, 28)) || identity.readUInt32LE(16) !== info.readUInt32LE(8))
      throw new Error("Native process helper executable and symbols do not match")
    return
  }
  throw new Error("Native process helper PDB identity is unavailable")
}
async function run(command: string, args: string[], timeout: number) {
  const proc = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    signal: AbortSignal.timeout(timeout),
  })
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.length
      if (size > 65536) {
        proc.kill()
        throw new Error("Native process helper diagnostics exceed their limit")
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited])
  if (code !== 0) throw new Error(`Native process helper validation failed: ${stderr || code}`)
  return stdout.trim()
}

const declaration = "raya-process-mode.json"
async function mode(directory: string) {
  const value: unknown = JSON.parse((await bytes(path.join(directory, declaration), 256)).toString("utf8"))
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !("version" in value) ||
    value.version !== 1 ||
    !("mode" in value) ||
    (value.mode !== "native" && value.mode !== "legacy")
  )
    throw new Error("Native process capability declaration is missing or invalid")
  return value.mode
}

export namespace ProcessHost {
  export const files = ["raya-process-host.exe", "raya-process-host.pdb", "raya-process-host.json"] as const
  export function include(source: string) {
    const rules = files.map((file) => `bin/${file}`)
    if (rules.some((rule) => !source.split(/\r?\n/).includes(rule)))
      throw new Error("Native process helper default packaging exclusions are missing")
    return rules.reduce((text, rule) => text.replace(rule, `!${rule}`), source)
  }
  export async function clear(directory: string) {
    await Promise.all([...files, declaration].map((file) => rm(path.join(directory, file), { force: true })))
  }
  async function inspect(directory: string, arch: string) {
    if (process.platform !== "win32" || process.arch !== "x64" || arch !== "x64")
      throw new Error("Native process helper packaging requires a Windows x64 host and target")
    const [exe, pdb, raw] = await Promise.all([
      bytes(path.join(directory, files[0]), 32 * 1024 * 1024),
      bytes(path.join(directory, files[1]), 64 * 1024 * 1024),
      bytes(path.join(directory, files[2]), 4096),
    ])
    const value: unknown = JSON.parse(raw.toString("utf8"))
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("recipe" in value) ||
      value.recipe !== (await recipe()) ||
      !("exe" in value) ||
      value.exe !== sha(exe) ||
      !("pdb" in value) ||
      value.pdb !== sha(pdb)
    )
      throw new Error("Native process helper build identity is stale or inconsistent")
    symbols(exe, pdb)
    const protocol: unknown = JSON.parse(await run(path.join(directory, files[0]), ["--protocol"], 15000))
    if (
      !protocol ||
      typeof protocol !== "object" ||
      !("version" in protocol) ||
      protocol.version !== 1 ||
      !("proof" in protocol) ||
      protocol.proof !== "windows-job" ||
      !("architecture" in protocol) ||
      protocol.architecture !== "x64"
    )
      throw new Error("Native process helper protocol or architecture is unsupported")
    await run(path.join(directory, files[0]), ["--self-test"], 30000)
  }
  export async function verify(directory: string, arch: string) {
    if ((await mode(directory)) === "legacy") return
    await inspect(directory, arch)
  }
  export async function legacy(directory: string) {
    await clear(directory)
    await mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, declaration), JSON.stringify({ version: 1, mode: "legacy" }))
    console.log(
      "declared legacy pinned Windows Job compatibility; native process helper is unavailable for this build host or target",
    )
  }
  export async function prepare(directory: string, arch: string) {
    if (process.platform !== "win32" || process.arch !== "x64" || arch !== "x64") return legacy(directory)
    await build(directory, arch)
  }
  export async function build(directory: string, arch: string) {
    await clear(directory)
    if (process.platform !== "win32" || process.arch !== "x64" || arch !== "x64")
      throw new Error("Native process helper cannot be built for this Windows host or target")
    const identity = await recipe()
    await mkdir(directory, { recursive: true })
    try {
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Output",
          path.join(directory, files[0]),
        ],
        180000,
      )
      if (identity !== (await recipe())) throw new Error("Native process helper source changed during its build")
      const [exe, pdb] = await Promise.all([
        bytes(path.join(directory, files[0]), 32 * 1024 * 1024),
        bytes(path.join(directory, files[1]), 64 * 1024 * 1024),
      ])
      await Bun.write(
        path.join(directory, files[2]),
        JSON.stringify({ version: 1, recipe: identity, exe: sha(exe), pdb: sha(pdb) }),
      )
      await inspect(directory, arch)
      await Bun.write(path.join(directory, declaration), JSON.stringify({ version: 1, mode: "native" }))
    } catch (err) {
      await clear(directory)
      throw err
    }
  }
  export async function stage(source: string, destination: string, arch: string) {
    await clear(destination)
    try {
      if ((await mode(source)) === "legacy") return legacy(destination)
      await verify(source, arch)
      await mkdir(destination, { recursive: true })
      await Promise.all(
        [...files, declaration].map((file) => copyFile(path.join(source, file), path.join(destination, file))),
      )
      await verify(destination, arch)
    } catch (err) {
      await clear(destination)
      throw err
    }
  }
}
