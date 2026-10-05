import { readFile } from "node:fs/promises"
import path from "node:path"
import type { MemorySchema } from "../schema"
import { marker, receipt } from "./review-schema"

/** Ordinary memory has no marker. Imported memory requires the exact destination review receipt. */
export async function reviewed(root: string, state: MemorySchema.State) {
  const text = await readFile(path.join(root, "restore.json"), "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (text === undefined) return state
  const imported = marker.parse(JSON.parse(text))
  const hold = receipt.parse(
    JSON.parse(await readFile(path.resolve(root, "../../storage/raya/restore-hold.json"), "utf8")),
  )
  if (hold.id !== imported.hold) throw new Error("Standalone memory destination review identity differs")
  if (hold.state === "released" && hold.review) return state
  return {
    ...state,
    enabled: false,
    autoInject: false,
    autoConsolidate: false,
    capture: { ...state.capture, turnClose: false, explicit: false },
  }
}
