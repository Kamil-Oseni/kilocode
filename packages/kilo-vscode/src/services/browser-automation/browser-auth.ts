import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { held } from "./browser-held"

const Capture = z.object({
  id: z.string().uuid(),
  profileID: z.string(),
  directory: z.string(),
  name: z.string().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  origins: z.array(z.string()),
  domains: z.array(z.string()),
  cookies: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type CaptureInfo = z.infer<typeof Capture> & { status: "available" | "expired" | "missing" | "invalid" }
export type BrowserIdentity = { profileID: string; directory: string }
export type AuthSource = {
  source: "live" | "capture"
  profileID: string
  captureID?: string
  captureName?: string
  capturedAt?: number
  expiresAt?: number
  login: "unverified"
}
export type ProfileInfo = BrowserIdentity & {
  status: "ready" | "closed" | "unavailable" | "locked" | "error" | "auth_expired"
  message?: string
  authentication: AuthSource
}
export type StorageState = {
  cookies: Array<{ domain?: string; name: string; value: string }>
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}
const limit = 64 * 1024 * 1024

export class BrowserAuth {
  constructor(
    private readonly root: string,
    readonly owner: BrowserIdentity,
  ) {}

  watch(changed: () => void) {
    const timer = setInterval(
      () =>
        void this.list().then(changed, () =>
          console.error("[Raya] Authentication cleanup failed; no secret contents were logged."),
        ),
      15 * 60 * 1000,
    )
    timer.unref()
    return () => clearInterval(timer)
  }

  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await held(this.root))) throw new Error("Authentication storage identity changed")
  }

  private file(id: string, suffix: string) {
    if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid authentication capture identity")
    return join(this.root, `${id}.${suffix}`)
  }

  private async receipt(id: string) {
    await this.directory()
    const path = this.file(id, "json")
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) throw new Error("Invalid authentication receipt")
    const info = Capture.parse(JSON.parse(await readFile(path, "utf8")))
    if (info.id !== id || info.profileID !== this.owner.profileID || info.directory !== this.owner.directory)
      throw new Error("Authentication capture belongs to another workspace profile")
    return info
  }

  private async erase(id: string) {
    await unlink(this.file(id, "state")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    })
  }

  async list(): Promise<CaptureInfo[]> {
    await this.directory()
    const records: CaptureInfo[] = []
    for (const file of await readdir(this.root)) {
      if (file.endsWith(".state") || file.endsWith(".tmp")) {
        const id = file.slice(0, file.lastIndexOf("."))
        if (!z.string().uuid().safeParse(id).success) continue
        const stat = await lstat(join(this.root, file)).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return
          throw error
        })
        if (!stat) continue
        if (!stat.isSymbolicLink() && stat.mtimeMs <= Date.now() - 7 * 86400000) await unlink(join(this.root, file))
        continue
      }
      if (!file.endsWith(".json")) continue
      const id = file.slice(0, -5)
      if (!z.string().uuid().safeParse(id).success) continue
      try {
        const info = await this.receipt(id)
        if (info.expiresAt <= Date.now()) {
          await this.erase(id)
          records.push({ ...info, status: "expired" })
          continue
        }
        const stat = await lstat(this.file(id, "state")).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return
          throw error
        })
        records.push({
          ...info,
          status: !stat
            ? "missing"
            : stat.isSymbolicLink() || !stat.isFile() || stat.size !== info.bytes
              ? "invalid"
              : "available",
        })
      } catch {
        records.push({
          ...this.owner,
          id,
          name: "Unreadable capture",
          createdAt: 0,
          expiresAt: 0,
          origins: [],
          domains: [],
          cookies: 0,
          bytes: 0,
          sha256: "0".repeat(64),
          status: "invalid",
        })
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt)
  }

  async capture(name: string, state: StorageState) {
    const records = await this.list()
    if (records.length >= 32)
      throw new Error(
        "This workspace has 32 authentication captures; delete an unused or expired capture before saving another",
      )
    if (!name.trim() || name.length > 200) throw new Error("Capture name must contain 1–200 characters")
    const text = JSON.stringify(state)
    const bytes = Buffer.byteLength(text)
    if (bytes > limit) throw new Error("Authentication capture exceeds the 64 MiB storage limit; no capture was saved")
    const id = randomUUID()
    const info = Capture.parse({
      ...this.owner,
      id,
      name: name.trim(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 86400000,
      origins: state.origins.map((item) => item.origin),
      domains: [...new Set(state.cookies.flatMap((cookie) => (cookie.domain ? [cookie.domain] : [])))],
      cookies: state.cookies.length,
      bytes,
      sha256: createHash("sha256").update(text).digest("hex"),
    })
    try {
      const statefile = await open(this.file(id, "state"), "wx", 0o600)
      try {
        await statefile.writeFile(text)
        await statefile.sync()
      } finally {
        await statefile.close()
      }
      const receipt = await open(this.file(id, "tmp"), "wx", 0o600)
      try {
        await receipt.writeFile(JSON.stringify(info))
        await receipt.sync()
      } finally {
        await receipt.close()
      }
      await rename(this.file(id, "tmp"), this.file(id, "json"))
      return { ...info, status: "available" as const }
    } catch (error) {
      await this.erase(id)
      throw error
    }
  }

  async read(id: string) {
    const info = await this.receipt(id)
    if (info.expiresAt <= Date.now()) {
      await this.erase(id)
      throw new Error("Authentication capture expired. Sign in and save a fresh capture.")
    }
    const file = this.file(id, "state")
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== info.bytes || stat.size > limit)
      throw new Error("Authentication capture bytes changed")
    const bytes = await readFile(file)
    if (createHash("sha256").update(bytes).digest("hex") !== info.sha256)
      throw new Error("Authentication capture digest changed")
    const state = (() => {
      try {
        return JSON.parse(bytes.toString("utf8")) as StorageState
      } catch {
        throw new Error("Authentication capture state is invalid; its contents were not disclosed")
      }
    })()
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins))
      throw new Error("Authentication capture state is invalid")
    return { info, state }
  }

  async delete(id: string) {
    await this.directory()
    await this.erase(id)
    await unlink(this.file(id, "json"))
  }

  async clear() {
    for (const info of await this.list()) await this.delete(info.id)
  }
}
