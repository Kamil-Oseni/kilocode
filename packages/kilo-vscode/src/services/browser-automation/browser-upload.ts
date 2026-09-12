import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { TransferOrigin } from "./browser-transfer"
import { held } from "./browser-held"
import { filename } from "./browser-save"

const File = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  selectedName: z.string().min(1).max(255).optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const Info = z.object({
  id: z.string().uuid(),
  tabID: z.string(),
  frameID: z.string().optional(),
  sessionID: z.string(),
  directory: z.string(),
  requestID: z.string(),
  destination: z.string(),
  files: z.array(File),
  status: z.enum(["staging", "selecting", "selected", "failed", "cancelled", "unknown"]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  error: z.string().optional(),
})
export type UploadFile = z.infer<typeof File>
export type UploadInfo = z.infer<typeof Info>
export type UploadTransport = {
  chunk(file: UploadFile, offset: number, signal: AbortSignal): Promise<{ data: string; offset: number; next: number }>
  release(file: UploadFile): Promise<void>
}
type Entry = {
  info: UploadInfo
  controller?: AbortController
  task?: Promise<void>
  write?: Promise<void>
  admission?: Promise<void>
}

export class BrowserUploads {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private ready?: Promise<void>
  private stopped = false
  constructor(private readonly root: string) {}

  load() {
    return (this.ready ??= this.restore())
  }
  private async restore() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await held(this.root))) throw new Error("Upload artifact directory identity changed")
    for (const id of await readdir(this.root)) {
      if (!z.string().uuid().safeParse(id).success) continue
      const dir = join(this.root, id)
      if ((await lstat(dir)).isSymbolicLink()) continue
      try {
        const file = join(dir, "receipt.json")
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) throw new Error("Upload receipt is invalid")
        const info = Info.parse(JSON.parse(await readFile(file, "utf8")))
        if (info.id !== id) throw new Error("Upload receipt identity changed")
        const entry: Entry = { info }
        this.entries.set(id, entry)
        if (["staging", "selecting"].includes(info.status)) {
          info.status = "unknown"
          info.error =
            "Browser stopped before file selection was acknowledged. Inspect the destination; do not repeat selection automatically."
          await this.persist(entry)
        }
        await this.clear(entry)
      } catch (error) {
        console.error("[Kilo New] Upload receipt could not be restored:", id, error)
      }
    }
  }

  private persist(entry: Entry) {
    entry.info.updatedAt = Date.now()
    const text = JSON.stringify(entry.info)
    const write = (entry.write ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const dir = join(this.root, entry.info.id)
        const file = join(dir, `${randomUUID()}.tmp`)
        const handle = await open(file, "wx", 0o600)
        try {
          await handle.writeFile(text)
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
          `Upload receipt could not be saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
        for (const listener of this.listeners) listener()
        throw error
      })
    entry.write = write
    return write
  }

  async start(
    input: {
      id: string
      tabID: string
      frameID?: string
      origin: TransferOrigin
      destination: string
      files: readonly UploadFile[]
    },
    transport: UploadTransport,
    select: (files: string[], signal: AbortSignal, dispatch: () => Promise<void>) => Promise<void>,
    cleanup: () => Promise<void>,
  ) {
    await this.load()
    const existing = this.entries.get(input.id)
    if (existing) {
      if (
        existing.info.requestID !== input.origin.requestID ||
        existing.info.sessionID !== input.origin.sessionID ||
        existing.info.directory !== input.origin.directory
      )
        throw new Error("Upload operation identity already belongs to another request")
      if (
        existing.info.tabID !== input.tabID ||
        existing.info.frameID !== input.frameID ||
        existing.info.destination !== input.destination ||
        JSON.stringify(existing.info.files.map(({ selectedName: _selected, ...file }) => file)) !==
          JSON.stringify(input.files)
      )
        throw new Error("Upload identity was reused with different content; no file selection was replayed")
      await existing.admission
      await cleanup()
      return this.list(input.origin, input.id)
    }
    if (this.stopped) throw new Error("Browser uploads are disposed")
    if ([...this.entries.values()].filter(({ info }) => ["staging", "selecting"].includes(info.status)).length >= 4)
      throw new Error("Four uploads are already active; inspect or cancel one before starting another")
    const info = Info.parse({
      ...input,
      files: input.files.map((file) => ({ ...file, selectedName: filename(file.name) })),
      ...input.origin,
      status: "staging",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const entry: Entry = { info, controller: new AbortController() }
    this.entries.set(info.id, entry)
    entry.admission = (async () => {
      try {
        await mkdir(join(this.root, info.id), { mode: 0o700 })
        await this.persist(entry)
      } catch (error) {
        entry.info.status = "unknown"
        entry.info.error =
          `Upload could not be admitted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
        for (const listener of this.listeners) listener()
        throw error
      }
    })()
    await entry.admission
    entry.task = this.run(entry, transport, select).finally(cleanup)
    void entry.task.catch((error) => console.error("[Kilo New] Upload execution stopped:", error))
    return this.list(input.origin, input.id)
  }

  private async run(
    entry: Entry,
    transport: UploadTransport,
    select: (files: string[], signal: AbortSignal, dispatch: () => Promise<void>) => Promise<void>,
  ) {
    const signal = entry.controller!.signal
    const paths: string[] = []
    let dispatched = false
    try {
      for (const file of entry.info.files) {
        signal.throwIfAborted()
        const dir = join(this.root, entry.info.id, file.id)
        await mkdir(dir, { mode: 0o700 })
        const target = join(dir, filename(file.name))
        const handle = await open(target, "wx", 0o600)
        const hash = createHash("sha256")
        let offset = 0
        try {
          while (offset < file.bytes) {
            signal.throwIfAborted()
            const chunk = await transport.chunk(file, offset, signal)
            signal.throwIfAborted()
            const bytes = Buffer.from(chunk.data, "base64")
            if (
              bytes.length === 0 ||
              bytes.length > 1024 * 1024 ||
              chunk.offset !== offset ||
              chunk.next !== offset + bytes.length ||
              chunk.next > file.bytes
            )
              throw new Error("Upload chunk does not match its authorized file reference")
            hash.update(bytes)
            await handle.writeFile(bytes)
            offset = chunk.next
          }
          if (hash.digest("hex") !== file.sha256)
            throw new Error("Upload bytes do not match the authorized file digest")
          await handle.sync()
        } finally {
          await handle.close()
        }
        paths.push(target)
        await transport.release(file)
      }
      signal.throwIfAborted()
      await select(paths, signal, async () => {
        signal.throwIfAborted()
        dispatched = true
        entry.info.status = "selecting"
        await this.persist(entry)
        signal.throwIfAborted()
      })
      entry.info.status = "selected"
      await this.persist(entry)
    } catch (error) {
      entry.info.status = dispatched || this.stopped ? "unknown" : signal.aborted ? "cancelled" : "failed"
      entry.info.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      await this.persist(entry)
    } finally {
      await Promise.all(
        entry.info.files.map((file) =>
          transport
            .release(file)
            .catch((error: unknown) => console.error("[Kilo New] Source upload staging cleanup failed:", error)),
        ),
      )
      if (entry.info.status === "failed" || entry.info.status === "cancelled") await this.clear(entry)
    }
  }

  async list(origin?: TransferOrigin, id?: string) {
    await this.load()
    const entries = [...this.entries.values()].filter(
      ({ info }) =>
        (!id || info.id === id) &&
        (!origin || (info.sessionID === origin.sessionID && info.directory === origin.directory)),
    )
    if (id && entries.length !== 1) throw new Error("Upload operation is unknown or belongs to another task")
    await Promise.all(
      entries.map(async (entry) => {
        await entry.admission?.catch(() => undefined)
        await entry.write?.catch(() => undefined)
      }),
    )
    return entries.slice(-50).map(({ info }) => ({ ...info, files: info.files.map((file) => ({ ...file })) }))
  }

  async cancel(id: string, origin?: TransferOrigin) {
    await this.list(origin, id)
    const entry = this.entries.get(id)!
    if (entry.info.status !== "staging")
      throw new Error(
        "File selection may already have submitted data. Inspect the destination; cancellation will not undo it.",
      )
    entry.controller?.abort(new Error("Upload staging cancelled before input selection"))
    await entry.task
    return this.list(origin, id)
  }

  private async clear(entry: Entry) {
    for (const file of entry.info.files)
      await unlink(join(this.root, entry.info.id, file.id, filename(file.name))).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return
        throw error
      })
  }
  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  stop() {
    this.stopped = true
    for (const entry of this.entries.values())
      entry.controller?.abort(new Error("Browser stopped; upload outcome requires inspection"))
    this.listeners.clear()
  }
  async close() {
    this.stop()
    await this.ready
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.admission))
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.task))
    for (const entry of this.entries.values()) await this.clear(entry)
  }
}
