import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { z } from "zod"
import { held } from "./browser-held"

const Origin = z.object({ requestID: z.string().min(1), sessionID: z.string().min(1), directory: z.string().min(1) })
export type TransferOrigin = z.infer<typeof Origin>
const Record = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  tabID: z.string().min(1),
  profile: z.string().min(1),
  origin: Origin.optional(),
  status: z.enum(["waiting", "receiving", "completed", "failed", "cancelled", "unknown"]),
  filename: z.string().max(200),
  url: z.string().max(20000),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  error: z.string().max(2000).optional(),
})
export type TransferInfo = z.infer<typeof Record>
export interface NativeDownload {
  suggestedFilename(): string
  url(): string
  path(): Promise<string | null>
  failure(): Promise<string | null>
  cancel(): Promise<void>
}
export interface TransferPage {
  on(event: "download", listener: (download: NativeDownload) => void): void
  off(event: "download", listener: (download: NativeDownload) => void): void
}
type Entry = {
  info: TransferInfo
  native?: NativeDownload
  task?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

function address(value: string) {
  try {
    const url = new URL(value)
    if (!["http:", "https:", "blob:"].includes(url.protocol)) return url.protocol
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href.slice(0, 20000)
  } catch {
    return "[unavailable]"
  }
}

export class BrowserTransfers {
  private readonly entries = new Map<string, Entry>()
  private readonly active = new Map<string, TransferOrigin>()
  private readonly armed = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: Array<() => void> = []
  private readonly writes = new Map<string, Promise<void>>()
  private readonly registrations = new Set<Promise<Entry>>()
  private ready?: Promise<void>
  private stopped = false
  constructor(
    private readonly root: string,
    private readonly profile: string,
  ) {}

  load(): Promise<void> {
    return (this.ready ??= this.restore())
  }

  private async restore() {
    await mkdir(this.root, { recursive: true })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("Download artifact directory must not be a link")
    if (!(await held(this.root))) throw new Error("Download artifact directory must resolve to its owned location")
    for (const name of await readdir(this.root)) {
      if (!z.string().uuid().safeParse(name).success) continue
      const dir = join(this.root, name)
      if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) continue
      try {
        const info = Record.parse(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")))
        if (info.id !== name || info.profile !== this.profile) continue
        const entry: Entry = { info }
        this.entries.set(info.id, entry)
        if (["waiting", "receiving"].includes(info.status)) {
          info.status = "unknown"
          info.error = "Browser stopped before transfer completion was recorded. Do not repeat the initiating action."
          await this.save(entry)
        }
      } catch (error) {
        console.error("[Kilo New] Browser download receipt could not be restored:", name, error)
      }
    }
  }

  private save(entry: Entry): Promise<void> {
    entry.info.updatedAt = Date.now()
    const content = JSON.stringify(entry.info)
    const previous = this.writes.get(entry.info.id) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const dir = join(this.root, entry.info.id)
        const file = join(dir, `${randomUUID()}.tmp`)
        const handle = await open(file, "wx", 0o600)
        try {
          await handle.writeFile(content)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(file, join(dir, "receipt.json"))
        for (const listener of this.listeners) listener()
      })
      .catch((error: unknown) => {
        entry.info.status = "unknown"
        entry.info.error =
          `Download receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2000,
          )
        for (const listener of this.listeners) listener()
        throw error
      })
    this.writes.set(entry.info.id, next)
    return next
  }

  private async create(tabID: string, origin?: TransferOrigin) {
    await this.load()
    if (this.stopped) throw new Error("Browser downloads are disposed")
    const id = randomUUID()
    const entry: Entry = {
      info: {
        version: 1,
        id,
        tabID,
        profile: this.profile,
        origin,
        status: "waiting",
        filename: "Download",
        url: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
    this.entries.set(id, entry)
    try {
      await mkdir(join(this.root, id), { mode: 0o700 })
      await this.save(entry)
    } catch (error) {
      entry.info.status = "unknown"
      entry.info.error =
        `Download could not be registered: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
      for (const listener of this.listeners) listener()
      throw error
    }
    return entry
  }

  async arm(tabID: string, origin: TransferOrigin) {
    if (this.armed.has(tabID)) throw new Error("A download is already awaiting its event in this tab; inspect it first")
    const entry = await this.create(tabID, origin)
    this.armed.set(tabID, entry)
    entry.timer = setTimeout(() => {
      this.armed.delete(tabID)
      entry.info.status = "unknown"
      entry.info.error =
        "No download event observed within 30 seconds. Inspect the page; do not automatically repeat the action."
      void this.save(entry).catch((error) => console.error("[Kilo New] Download timeout could not be recorded:", error))
    }, 30000)
    return entry.info.id
  }

  own(tabID: string, origin?: TransferOrigin) {
    const armed = this.armed.get(tabID)
    if (armed && armed.info.origin?.requestID !== origin?.requestID)
      throw new Error("This tab is awaiting a download from another operation; inspect or cancel that transfer first")
    if (origin) this.active.set(tabID, origin)
    return () => {
      if (this.active.get(tabID) === origin) this.active.delete(tabID)
    }
  }

  attach(page: TransferPage, tabID: string) {
    const listener = (native: NativeDownload) => {
      const armed = this.armed.get(tabID)
      this.armed.delete(tabID)
      if (armed?.timer) clearTimeout(armed.timer)
      const origin = this.active.get(tabID)
      const task = (async () => {
        const entry = armed ?? (await this.create(tabID, origin))
        entry.native = native
        entry.info.filename =
          native
            .suggestedFilename()
            .replace(/[\x00-\x1f\x7f]/g, "")
            .slice(0, 200) || "Download"
        entry.info.url = address(native.url())
        if ([...this.entries.values()].filter((item) => item.info.status === "receiving").length >= 8) {
          await native.cancel()
          entry.info.status = "failed"
          entry.info.error =
            "Eight downloads are already receiving; this transfer was cancelled before artifact capture."
          await this.save(entry)
          return entry
        }
        entry.info.status = "receiving"
        await this.save(entry)
        return entry
      })()
      this.registrations.add(task)
      void task
        .then((entry) => {
          if (entry.info.status !== "receiving") return
          entry.task = this.capture(entry, native)
          return entry.task
        })
        .catch(async (error: unknown) => {
          await native
            .cancel()
            .catch((failure: unknown) =>
              console.error("[Kilo New] Unregistered download cancellation failed:", failure),
            )
          console.error("[Kilo New] Browser download capture failed:", error)
        })
        .finally(() => this.registrations.delete(task))
    }
    page.on("download", listener)
    this.cleanup.push(() => page.off("download", listener))
  }

  private async capture(entry: Entry, native: NativeDownload) {
    try {
      const source = await native.path()
      const failure = await native.failure()
      if (failure || !source) throw new Error(failure ?? "Browser returned no downloaded file")
      if (this.entries.get(entry.info.id)?.info.status === "cancelled") return
      const hash = createHash("sha256")
      let bytes = 0
      await pipeline(
        createReadStream(source),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length
            hash.update(chunk)
            callback(null, chunk)
          },
        }),
        createWriteStream(join(this.root, entry.info.id, "artifact"), { flags: "wx", mode: 0o600 }),
      )
      const handle = await open(join(this.root, entry.info.id, "artifact"), "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (this.entries.get(entry.info.id)?.info.status === "cancelled") return
      entry.info.bytes = bytes
      entry.info.sha256 = hash.digest("hex")
      entry.info.status = "completed"
    } catch (error) {
      if (entry.info.status !== "cancelled") {
        entry.info.status = this.stopped ? "unknown" : "failed"
        entry.info.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      }
    }
    await this.save(entry)
  }

  async list(origin?: TransferOrigin, id?: string, offset = 0, requestID?: string) {
    await this.load()
    await Promise.allSettled(this.registrations)
    const records = [...this.entries.values()].filter(
      ({ info }) =>
        (!id || info.id === id) &&
        (!requestID || info.origin?.requestID === requestID) &&
        (!origin || (info.origin?.sessionID === origin.sessionID && info.origin.directory === origin.directory)),
    )
    await Promise.all(records.map(({ info }) => this.writes.get(info.id)?.catch(() => undefined)))
    if (id && records.length !== 1) throw new Error("Download identity is unknown or belongs to another task")
    return {
      transfers: records
        .slice(offset, offset + 50)
        .map(({ info }) => ({ ...info, origin: info.origin && { ...info.origin } })),
      next: offset + 50 < records.length ? offset + 50 : undefined,
    }
  }

  async observed(origin: TransferOrigin): Promise<TransferInfo[]> {
    const current = () => this.list(origin, undefined, 0, origin.requestID).then((result) => result.transfers)
    const existing = await current()
    if (existing.length) return existing
    return new Promise((resolve, reject) => {
      const finish = (records: TransferInfo[]) => {
        clearTimeout(timer)
        off()
        resolve(records)
      }
      const inspect = () =>
        void current().then(
          (records) => {
            if (records.length) finish(records)
          },
          (error: unknown) => {
            clearTimeout(timer)
            off()
            reject(error)
          },
        )
      const off = this.onChange(inspect)
      const timer = setTimeout(() => finish([]), 5000)
      inspect()
    })
  }

  async cancel(id: string, origin?: TransferOrigin) {
    await this.list(origin, id)
    const entry = this.entries.get(id)!
    if (!["waiting", "receiving"].includes(entry.info.status))
      throw new Error("Only a pending download can be cancelled")
    if (entry.timer) clearTimeout(entry.timer)
    if (this.armed.get(entry.info.tabID) === entry) this.armed.delete(entry.info.tabID)
    if (entry.native) await entry.native.cancel()
    if (entry.info.status === "completed") return
    entry.info.status = "cancelled"
    await this.save(entry)
  }

  async artifact(id: string, origin?: TransferOrigin) {
    await this.list(origin, id)
    const entry = this.entries.get(id)!
    if (entry.info.status !== "completed") throw new Error("Download is not complete")
    const file = join(this.root, id, "artifact")
    if (!(await held(file)) || !(await lstat(file)).isFile()) throw new Error("Download artifact identity changed")
    const hash = createHash("sha256")
    let bytes = 0
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length
      hash.update(chunk)
    }
    if (bytes !== entry.info.bytes || hash.digest("hex") !== entry.info.sha256)
      throw new Error("Download artifact no longer matches its completion receipt")
    return file
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  takeover() {
    this.active.clear()
    for (const entry of this.armed.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.info.status = "unknown"
      entry.info.error =
        "Manual control interrupted download event attribution. Inspect the page and downloads before another action."
      void this.save(entry).catch((error) =>
        console.error("[Kilo New] Download takeover could not be recorded:", error),
      )
    }
    this.armed.clear()
  }
  dispose() {
    this.stopped = true
    for (const cleanup of this.cleanup) cleanup()
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
    this.listeners.clear()
  }
}
