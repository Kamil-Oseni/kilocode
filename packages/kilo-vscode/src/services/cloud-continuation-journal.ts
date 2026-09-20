import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { z } from "zod"

const record = z.object({
  claim: z.string().uuid(),
  revision: z.number().finite(),
  created: z.number().finite().nonnegative(),
  sessionID: z.string().min(1).optional(),
})
const schema = z.object({ version: z.literal(1), records: z.record(z.string(), record) })

export type CloudContinuationRecord = z.infer<typeof record>

export class CloudContinuationJournal {
  private readonly file: string
  private readonly locks: string

  constructor(private readonly root: string) {
    this.file = join(root, "continuations.json")
    this.locks = join(root, ".locks")
  }

  private lock<T>(work: () => Promise<T>) {
    return Flock.withLock("raya-cloud-continuations", work, {
      dir: this.locks,
      staleMs: 60_000,
      timeoutMs: 120_000,
    })
  }

  private async read() {
    const raw = await readFile(this.file, "utf8").then(
      (value) => value,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw err
      },
    )
    if (raw === undefined) return { version: 1 as const, records: {} as Record<string, CloudContinuationRecord> }
    const saved = schema.safeParse(JSON.parse(raw))
    if (!saved.success) throw new Error("Cloud continuation recovery data is invalid and was retained.")
    return saved.data
  }

  private async write(value: z.infer<typeof schema>) {
    await mkdir(this.root, { recursive: true })
    const tmp = join(this.root, `continuations.${process.pid}.${randomUUID()}.tmp`)
    const file = await open(tmp, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, this.file)
  }

  get(key: string) {
    return this.lock(async () => (await this.read()).records[key])
  }

  claim(key: string, value: CloudContinuationRecord) {
    return this.lock(async () => {
      const saved = await this.read()
      const found = saved.records[key]
      if (found) return { acquired: false as const, record: found }
      await this.write({ ...saved, records: { ...saved.records, [key]: value } })
      return { acquired: true as const, record: value }
    })
  }

  complete(key: string, claim: string, sessionID: string) {
    return this.lock(async () => {
      const saved = await this.read()
      const found = saved.records[key]
      if (!found || found.claim !== claim) throw new Error("Cloud continuation reservation no longer belongs to this request.")
      await this.write({ ...saved, records: { ...saved.records, [key]: { ...found, sessionID } } })
    })
  }

  clear(key: string, claim: string) {
    return this.lock(async () => {
      const saved = await this.read()
      const found = saved.records[key]
      if (!found || found.claim !== claim) return false
      const records = { ...saved.records }
      delete records[key]
      await this.write({ ...saved, records })
      return true
    })
  }
}
