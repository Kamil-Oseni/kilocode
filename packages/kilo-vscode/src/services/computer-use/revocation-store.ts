import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

const limit = 1024
const size = 64 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class ComputerUseRevocationStore {
  private readonly path: string
  private readonly ids: Set<string>
  private writes: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    if (!isAbsolute(dir)) throw new Error("Computer Use revocations need an absolute directory")
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, "revocations.json")
    try {
      if (statSync(this.path).size > size) throw new Error("Computer Use revocation record exceeds its size limit")
      const data: unknown = JSON.parse(readFileSync(this.path, "utf8"))
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).length !== 2 ||
        !("version" in data) ||
        data.version !== 1 ||
        !("ids" in data) ||
        !Array.isArray(data.ids) ||
        data.ids.length > limit ||
        data.ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
        new Set(data.ids).size !== data.ids.length
      )
        throw new Error("Malformed Computer Use revocation record")
      this.ids = new Set(data.ids)
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        this.ids = new Set()
        return
      }
      throw err
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  add(id: string): Promise<void> {
    if (!uuid.test(id)) return Promise.reject(new Error("Computer Use revocation needs an exact lease UUID"))
    const task = this.writes.then(async () => {
      if (this.ids.has(id)) return
      if (this.ids.size >= limit) throw new Error("Computer Use revocation record is full")
      const ids = [...this.ids, id]
      const tmp = `${this.path}.${randomUUID()}.tmp`
      try {
        const file = await open(tmp, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify({ version: 1, ids }), "utf8")
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(tmp, this.path)
        this.ids.add(id)
      } finally {
        await rm(tmp, { force: true })
      }
    })
    this.writes = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
}
