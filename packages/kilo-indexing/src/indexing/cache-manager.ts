import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import type { ICacheManager } from "./interfaces/cache"
import { Log } from "../util/log"

const log = Log.create({ service: "indexing-cache" })

/**
 * Manages the file-hash cache for code indexing.
 *
 * RATIONALE: Replaced vscode.ExtensionContext storage and vscode.workspace.fs
 * with plain filesystem access so the cache manager works outside VS Code.
 */
export class CacheManager implements ICacheManager {
  private readonly cachePath: string
  private fileHashes: Record<string, string> = {}
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saveTask = Promise.resolve()
  private readonly failures: unknown[] = []
  private readonly tasks = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined
  private dirty = false

  private admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Index cache admission is closed"))
    const ticket = Promise.withResolvers<T>()
    const task = ticket.promise
    this.tasks.add(task)
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    )
    try {
      ticket.resolve(work())
    } catch (err) {
      ticket.reject(err)
    }
    return task
  }

  private mutable() {
    if (this.closing) throw new Error("Index cache admission is closed")
    this.dirty = true
  }

  constructor(
    private readonly cacheDirectory: string,
    private readonly workspacePath: string,
  ) {
    const hash = createHash("sha256").update(workspacePath).digest("hex")
    this.cachePath = path.join(cacheDirectory, `roo-index-cache-${hash}.json`)
  }

  initialize(): Promise<void> {
    return this.admit(() => this.load())
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cachePath, "utf-8")
      this.fileHashes = JSON.parse(raw)
    } catch (err) {
      if (!(err instanceof SyntaxError) && !(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        this.failures.push(err)
        throw err
      }
      this.fileHashes = {}
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.flush().catch((err) => log.error("failed to save cache", { err }))
    }, 1500)
  }

  private async performSave(): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
    const tmp = `${this.cachePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.fileHashes), "utf-8")
    await fs.rename(tmp, this.cachePath)
  }

  flush(): Promise<void> {
    return this.admit(() => this.publish())
  }

  private async publish(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const task = this.saveTask.then(() => this.performSave())
    this.saveTask = task.catch((err) => {
      this.failures.push(err)
      log.error("failed to save cache", { err })
    })
    await task
  }

  seedHashes(hashes: Readonly<Record<string, string>>): void {
    this.mutable()
    this.fileHashes = { ...hashes }
    this.scheduleSave()
  }

  async clearCacheFile(): Promise<void> {
    this.mutable()
    this.fileHashes = {}
    await this.flush()
  }

  getHash(filePath: string): string | undefined {
    return this.fileHashes[filePath]
  }

  updateHash(filePath: string, hash: string): void {
    this.mutable()
    this.fileHashes[filePath] = hash
    this.scheduleSave()
  }

  deleteHash(filePath: string): void {
    this.mutable()
    delete this.fileHashes[filePath]
    this.scheduleSave()
  }

  getAllHashes(): Record<string, string> {
    return { ...this.fileHashes }
  }

  signature(): string {
    const entries = Object.entries(this.fileHashes).sort(([left], [right]) => left.localeCompare(right))
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
  }

  async stamp(): Promise<string | undefined> {
    return this.admit(() =>
      fs
        .stat(this.cachePath)
        .then((value) => `${value.mtimeMs}:${value.ctimeMs}:${value.size}`)
        .catch((err) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
          this.failures.push(err)
          throw err
        }),
    )
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const accepted = [...this.tasks]
    this.closing = (async () => {
      await Promise.allSettled(accepted)
      await this.saveTask
      if (this.dirty) await this.publish()
      if (this.failures.length) throw new AggregateError(this.failures, "Index cache cleanup remains unconfirmed")
    })()
    return this.closing
  }
}
