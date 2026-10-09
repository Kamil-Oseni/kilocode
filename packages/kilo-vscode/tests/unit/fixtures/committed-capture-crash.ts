import { readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { BrainSettings } from "../../../src/second-brain/settings"

const file = process.argv[2]
const stage = process.argv[3]
const storage = {
  get<T>(key: string) {
    return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
  },
  async update(key: string, item: unknown) {
    const data = JSON.parse(await readFile(file, "utf8"))
    if (item === undefined) delete data[key]
    if (item !== undefined) data[key] = item
    await writeFile(file, JSON.stringify(data))
    if (stage === "state" && key === "raya.secondBrain.setup") process.exit(71)
    if (stage === "clear" && key === "raya.secondBrain.control.uncertainty" && item === undefined) process.exit(71)
    if (
      ["verified", "applied"].includes(stage) &&
      key.startsWith("raya.secondBrain.committedCaptureRecovery.") &&
      item &&
      typeof item === "object" &&
      "phase" in item &&
      item.phase === stage
    )
      process.exit(71)
  },
}
const settings = new BrainSettings(storage, {
  async get() {
    return "synthetic"
  },
  async store() {},
  async delete() {},
})
const turns = storage.get<unknown[]>("raya.secondBrain.personalCapture.turns")!
await settings.recoverCapture(process.cwd(), turns[0], async () => true)
throw new Error("Synthetic interruption checkpoint was not reached")
