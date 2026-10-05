import path from "node:path"
import fs from "node:fs/promises"
import { ZipReader, Uint8ArrayReader } from "@zip.js/zip.js"
import { spawn } from "@/lsp/launch"
import { model } from "@/kilocode/process/env"
import { admission, settle } from "./admission"
import { command, own } from "./process"

const limit = 128 * 1024 * 1024

function relative(name: string) {
  const value = name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
  if (
    !value ||
    value.startsWith("/") ||
    /[\x00-\x1f]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => part === "..") ||
    (process.platform === "win32" && /[<>:"|?*]/.test(value))
  )
    throw new Error("Language-server archive path escapes staging")
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          (process.platform === "win32" &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))),
      )
  )
    throw new Error("Language-server archive path is not canonical")
  return value
}

async function ordinary(dir: string) {
  const info = await fs.lstat(dir)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    throw new Error("Language-server installation contains a nonordinary entry")
  if (!info.isDirectory()) return
  for (const name of await fs.readdir(dir)) await ordinary(path.join(dir, name))
}

export async function extract(file: string, dir: string, zip: boolean) {
  if (zip) {
    const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(await fs.readFile(file))))
    await settle(
      async () => {
        const entries = await reader.getEntries()
        if (entries.length > 20_000) throw new Error("Language-server archive entry bound exceeded")
        const names = new Set<string>()
        let total = 0
        for (const entry of entries) {
          total += entry.uncompressedSize
          if (!Number.isSafeInteger(total) || total > limit * 2)
            throw new Error("Language-server expanded archive exceeds its bound")
          const name = relative(entry.filename).replace(/\/$/, "")
          const key = process.platform === "win32" ? name.toLowerCase() : name
          if (names.has(key) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
            throw new Error("Language-server archive has duplicate or symbolic entries")
          names.add(key)
        }
      },
      () => reader.close(),
    )
    const shell = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    const env = model(process.env)
    await command(
      spawn(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $env:OPENCODE_ARCHIVE_PATH -DestinationPath $env:OPENCODE_ARCHIVE_DESTINATION",
        ],
        {
          env: {
            ...env,
            PSModulePath: path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/Modules"),
            OPENCODE_ARCHIVE_PATH: file,
            OPENCODE_ARCHIVE_DESTINATION: dir,
          },
        },
      ),
    )
    return
  }
  const listing = await command(spawn("tar", ["-tzf", file], {}))
  const types = await command(spawn("tar", ["-tvzf", file], {}))
  const names = listing.toString().split(/\r?\n/).filter(Boolean)
  const rows = types.toString().split(/\r?\n/).filter(Boolean)
  if (names.length > 20_000 || names.length !== rows.length || rows.some((row) => !/^[-d]/.test(row)))
    throw new Error("Language-server tar contains unsupported entries")
  let total = 0
  for (const row of rows) {
    // GNU and BSD tar have different owner columns. Unknown formats refuse before extraction.
    const match =
      /^[-d]\S*\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s/.exec(row) ??
      /^[-d]\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Z][a-z]{2}\s/.exec(row)
    if (!match || !/^\d{1,12}$/.test(match[1])) throw new Error("Unsupported language-server tar size metadata")
    total += Number(match[1])
    if (!Number.isSafeInteger(total) || total > limit * 2)
      throw new Error("Language-server expanded tar exceeds its bound")
  }
  for (const name of names) relative(name)
  await command(spawn("tar", ["-xzf", file, "-C", dir], {}))
}

async function bytes(response: Response, maximum = limit) {
  if (!response.body) throw new Error("Language-server download has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  return settle(
    async () => {
      if (!response.ok) throw new Error("Language-server download failed")
      while (true) {
        const row = await reader.read()
        if (row.done) return Buffer.concat(chunks)
        count += row.value.byteLength
        if (count > maximum) throw new Error("Language-server archive exceeds its bound")
        chunks.push(row.value)
      }
    },
    async () => {
      await settle(
        () => reader.cancel(),
        async () => reader.releaseLock(),
      )
    },
  )
}

/** Dependency selection is private to the host implementation; the normal release URL remains fixed. */
export function create(
  opts: {
    fetch?: typeof fetch
    release?: string
    launch?: (binary: string, cwd: string) => ReturnType<typeof spawn>
    extract?: typeof extract
    owner?: typeof admission
  } = {},
) {
  return async (selected: string, cwd: string) =>
    (opts.owner ?? admission).open(selected, async (root, scope) => {
      const arch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "ia32" : "x64"
      const suffix = `${process.platform}-${arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`
      if (
        ![
          "darwin-arm64.tar.gz",
          "darwin-x64.tar.gz",
          "linux-x64.tar.gz",
          "linux-arm64.tar.gz",
          "win32-x64.zip",
          "win32-ia32.zip",
        ].includes(suffix)
      )
        throw new Error("Unsupported managed Lua language-server platform")
      const target = path.join(root, `lua-language-server-${arch}-${process.platform}`)
      await scope.cover(target)
      const binary = path.join(target, "bin", `lua-language-server${process.platform === "win32" ? ".exe" : ""}`)
      const installed = await fs.lstat(binary).then(
        () => true,
        (err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
          throw err
        },
      )
      if (!installed) {
        const response = await (opts.fetch ?? fetch)(
          opts.release ?? "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
        )
        const release: unknown = JSON.parse((await bytes(response, 1024 * 1024)).toString())
        if (
          !release ||
          typeof release !== "object" ||
          !("tag_name" in release) ||
          typeof release.tag_name !== "string" ||
          !("assets" in release) ||
          !Array.isArray(release.assets)
        )
          throw new Error("Invalid language-server release metadata")
        const name = `lua-language-server-${release.tag_name}-${suffix}`
        const asset = release.assets.find(
          (row: unknown) => row && typeof row === "object" && "name" in row && row.name === name,
        )
        if (
          !asset ||
          typeof asset !== "object" ||
          !("browser_download_url" in asset) ||
          typeof asset.browser_download_url !== "string"
        )
          throw new Error("Missing language-server release asset")
        const id = crypto.randomUUID()
        const archive = path.join(root, `.lua-${id}.${process.platform === "win32" ? "zip" : "tar.gz"}`)
        const stage = path.join(root, `.lua-${id}.stage`)
        const backup = path.join(root, `.lua-${id}.previous`)
        for (const file of [archive, stage, backup]) await scope.cover(file)
        const pins = new Map<string, { dev: bigint; ino: bigint; directory: boolean }>()
        const capture = async (file: string) => {
          const pin = await fs.lstat(file, { bigint: true })
          if (pin.isSymbolicLink() || (!pin.isDirectory() && (!pin.isFile() || pin.nlink !== 1n)))
            throw new Error("Language-server staging identity is nonordinary")
          pins.set(file, { dev: pin.dev, ino: pin.ino, directory: pin.isDirectory() })
          return pin
        }
        const identity = async (file: string) => {
          await scope.check()
          const pin = pins.get(file)
          const current = await fs.lstat(file, { bigint: true }).catch((err: unknown) => {
            if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
            throw err
          })
          if (!current) return false
          if (
            !pin ||
            current.isSymbolicLink() ||
            current.dev !== pin.dev ||
            current.ino !== pin.ino ||
            current.isDirectory() !== pin.directory ||
            (!pin.directory && (!current.isFile() || current.nlink !== 1n))
          )
            throw new Error("Language-server cleanup refuses a replaced staging identity")
          return true
        }
        const remove = async (file: string, recursive: boolean) => {
          if (await identity(file)) await fs.rm(file, { recursive, force: false })
        }
        let moved = false
        let published = false
        await settle(
          async () => {
            const data = await bytes(await (opts.fetch ?? fetch)(asset.browser_download_url))
            await scope.check()
            await fs.writeFile(archive, data, { flag: "wx" })
            await capture(archive)
            await scope.check()
            await fs.mkdir(stage)
            const pin = await capture(stage)
            const check = async () => {
              await scope.check()
              const info = await fs.lstat(stage, { bigint: true })
              if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== pin.dev || info.ino !== pin.ino)
                throw new Error("Language-server staging binding changed")
            }
            await check()
            if (!(await identity(archive))) throw new Error("Language-server archive disappeared")
            await (opts.extract ?? extract)(archive, stage, process.platform === "win32")
            await check()
            await ordinary(stage)
            const executable = path.join(stage, "bin", path.basename(binary))
            const info = await fs.lstat(executable)
            if (!info.isFile() || info.isSymbolicLink())
              throw new Error("Language-server executable is missing or nonordinary")
            if (process.platform !== "win32") {
              await check()
              await fs.chmod(executable, 0o755)
            }
            const exists = await fs.lstat(target).then(
              () => true,
              (err: unknown) => {
                if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
                throw err
              },
            )
            if (exists) {
              await ordinary(target)
              const previous = await fs.lstat(target, { bigint: true })
              await check()
              await fs.rename(target, backup)
              pins.set(backup, { dev: previous.dev, ino: previous.ino, directory: true })
              moved = true
            }
            await check()
            await fs.rename(stage, target)
            published = true
          },
          async () => {
            const failures: unknown[] = []
            if (moved && !published)
              await (async () => {
                if (!(await identity(backup))) throw new Error("Language-server rollback backup disappeared")
                const current = await fs.lstat(target).catch((err: unknown) => {
                  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
                  throw err
                })
                if (current) throw new Error("Language-server rollback destination was replaced")
                await fs.rename(backup, target)
              })().catch((err: unknown) => failures.push(err))
            const results = await Promise.allSettled([
              remove(archive, false),
              remove(stage, true),
              ...(published ? [remove(backup, true)] : []),
            ])
            const errors = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
            if (errors.length || failures.length)
              throw new AggregateError([...failures, ...errors], "Language-server installation cleanup failed")
          },
        )
      }
      await scope.check()
      await ordinary(target)
      const pin = await fs.lstat(target, { bigint: true })
      const check = async () => {
        await scope.check()
        const current = await fs.lstat(target, { bigint: true })
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== pin.dev || current.ino !== pin.ino)
          throw new Error("Language-server runtime installation binding changed")
      }
      await check()
      const child = opts.launch ? opts.launch(binary, cwd) : spawn(binary, { cwd })
      const runtime = own(child)
      await check().catch((err: unknown) =>
        settle(
          async () => {
            throw err
          },
          () => runtime.close(),
        ),
      )
      return {
        ...runtime,
        joined: settle(() => runtime.joined, check),
        close: () => settle(() => runtime.close(), check),
      }
    })
}

export const lua = create()
