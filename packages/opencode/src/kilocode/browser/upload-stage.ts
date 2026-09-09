import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { KiloReadObject } from "@/kilocode/tool/read-object"
import { UploadFile } from "./upload-schema"

const Count = Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Receipt = Schema.Struct({
  file: UploadFile,
  sessionID: Schema.String,
  directory: Schema.String,
  uploadID: Schema.String,
  expires: Count,
})
type Owner = { sessionID: string; directory: string; uploadID: string }

export class UploadStage {
  constructor(private readonly root: string = path.join(Global.Path.cache, "browser-uploads")) {}

  watch() {
    const clean = () =>
      void this.prune().catch((error: unknown) => console.error("Upload staging cleanup failed:", error))
    clean()
    const timer = setInterval(clean, 15 * 60 * 1000)
    timer.unref()
    return () => clearInterval(timer)
  }

  async prune() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await realpath(this.root)) !== path.resolve(this.root))
      throw new Error("Upload staging directory identity changed")
    for (const id of await readdir(this.root)) {
      if (!Schema.is(Schema.String.check(Schema.isUUID()))(id)) continue
      const dir = path.join(this.root, id)
      const stat = await lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      if (stat.mtimeMs > Date.now() - 3600000) continue
      await this.erase(dir)
    }
  }

  private async erase(dir: string) {
    await unlink(path.join(dir, "bytes")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
  }

  private async receipt(owner: Owner, id: string) {
    const dir = await this.directory(id)
    if ((await realpath(dir)) !== path.resolve(dir)) throw new Error("Upload reference identity changed")
    const file = path.join(dir, "receipt.json")
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) throw new Error("Invalid upload receipt")
    const receipt = Schema.decodeUnknownSync(Receipt)(JSON.parse(await readFile(file, "utf8")))
    if (
      receipt.file.id !== id ||
      receipt.sessionID !== owner.sessionID ||
      receipt.directory !== owner.directory ||
      receipt.uploadID !== owner.uploadID
    )
      throw new Error("Upload reference belongs to another task or operation")
    return { dir, receipt }
  }

  private async directory(id: string) {
    if (!Schema.is(Schema.String.check(Schema.isUUID()))(id)) throw new Error("Invalid upload file reference")
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await realpath(this.root)) !== path.resolve(this.root))
      throw new Error("Upload staging directory identity changed")
    return path.join(this.root, id)
  }

  async stage(owner: Owner, file: KiloReadObject.File, signal: AbortSignal) {
    const id = randomUUID()
    const dir = await this.directory(id)
    await mkdir(dir, { mode: 0o700 })
    const hash = createHash("sha256")
    let bytes = 0
    try {
      await pipeline(
        file.stream(signal),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length
            hash.update(chunk)
            callback(null, chunk)
          },
        }),
        createWriteStream(path.join(dir, "bytes"), { flags: "wx", mode: 0o600 }),
        { signal },
      )
      const digest = hash.digest("hex")
      const verified = createHash("sha256")
      for await (const chunk of file.stream(signal)) verified.update(chunk)
      if (verified.digest("hex") !== digest)
        throw new Error("Upload source changed while staging; no file was sent to the browser")
      const stat = await file.handle.stat({ bigint: true })
      if (stat.size !== BigInt(bytes) || stat.mtimeNs !== file.stat.mtimeNs || stat.ctimeNs !== file.stat.ctimeNs)
        throw new Error("Upload source changed after authorization")
      const info = { id, name: path.basename(file.requested).slice(0, 255), bytes, sha256: digest }
      const artifact = await open(path.join(dir, "bytes"), "r+")
      try {
        await artifact.sync()
      } finally {
        await artifact.close()
      }
      const handle = await open(path.join(dir, "receipt.tmp"), "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ file: info, ...owner, expires: Date.now() + 3600000 }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(path.join(dir, "receipt.tmp"), path.join(dir, "receipt.json"))
      return info
    } catch (error) {
      await unlink(path.join(dir, "bytes")).catch((failure: unknown) => {
        if (failure instanceof Error && "code" in failure && failure.code === "ENOENT") return
        throw failure
      })
      throw error
    }
  }

  async chunk(owner: Owner, id: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid upload offset")
    const { dir, receipt } = await this.receipt(owner, id)
    if (receipt.expires < Date.now()) {
      await this.erase(dir)
      throw new Error("Upload reference expired; select a fresh authorized file")
    }
    if (offset > receipt.file.bytes) throw new Error("Upload offset exceeds the authorized file")
    const source = path.join(dir, "bytes")
    if ((await realpath(source)) !== path.resolve(source)) throw new Error("Upload bytes identity changed")
    const handle = await open(source, "r")
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== receipt.file.bytes) throw new Error("Staged upload bytes changed")
      const buffer = Buffer.alloc(Math.min(1024 * 1024, receipt.file.bytes - offset))
      const read = await handle.read(buffer, 0, buffer.length, offset)
      if (read.bytesRead !== buffer.length) throw new Error("Staged upload ended unexpectedly")
      return { data: buffer.toString("base64"), offset, next: offset + read.bytesRead }
    } finally {
      await handle.close()
    }
  }

  async release(owner: Owner, id: string) {
    const { dir } = await this.receipt(owner, id)
    await this.erase(dir)
  }
}
