import type { Memento } from "vscode"
import { z } from "zod"

const key = "raya.update.installation.v1"
const schema = z.object({
  version: z.string().min(1).max(256),
  previous: z.string().min(1).max(256),
  phase: z.enum(["installing", "awaiting-reload"]),
})

/** Persist intent before installer dispatch; completion is confirmed by the running extension version. */
export class Installation {
  constructor(private readonly state: Pick<Memento, "get" | "update">) {}

  async run(version: string, previous: string, install: () => Promise<void>) {
    const record = schema.parse({ version, previous, phase: "installing" })
    await this.state.update(key, record)
    await install()
    await this.state.update(key, { ...record, phase: "awaiting-reload" })
  }

  async recover(version: string) {
    const raw = this.state.get<unknown>(key)
    if (raw === undefined) return
    const record = schema.safeParse(raw)
    if (!record.success)
      throw new Error("The saved update installation record is invalid; it has been retained for diagnosis.")
    if (record.data.version !== version) return record.data
    await this.state.update(key, undefined)
  }
}
