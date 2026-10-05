import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Option, Schema } from "effect"
import { Receipt } from "../goal/stop-receipt"
import { Codec as Task } from "../task/schema"

type Table = Readonly<{
  table: string
  columns: readonly string[]
  rows: readonly (readonly (string | number | null)[])[]
}>
type Content = Readonly<{ json: readonly Readonly<{ path: string; value: string }>[]; sql?: readonly Table[] }>
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Validate original historical evidence only; no receipt can create destination execution ownership. */
export function goalStop(file: string, text: string, content: Content) {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(Receipt))(text, { onExcessProperty: "error" })
  if (Option.isNone(result)) return false
  const receipt = result.value
  if (!Number.isFinite(receipt.at) || receipt.at < 0) return false
  if (
    receipt.phase === "finished" &&
    (typeof receipt.interrupted !== "boolean" ||
      receipt.finishedAt === undefined ||
      !Number.isFinite(receipt.finishedAt) ||
      receipt.finishedAt < receipt.at)
  )
    return false
  if (file !== `raya/goal-stops/${receipt.sessionID}/${digest(receipt.intent)}.json`) return false
  if (!receipt.task || !content.sql || receipt.task.runs.length !== 1) return false
  const sessions = content.sql.filter((table) => table.table === "session")
  if (sessions.length !== 1) return false
  const table = sessions[0]
  const rows = table.rows.filter((row) => row[table.columns.indexOf("id")] === receipt.sessionID)
  if (rows.length !== 1) return false
  const raw = rows[0][table.columns.indexOf("metadata")]
  if (typeof raw !== "string") return false
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)
  if (Option.isNone(parsed)) return false
  const metadata = parsed.value
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const identity: unknown = Reflect.get(metadata, "rayaRoutine")
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false
  if (digest(JSON.stringify(identity)) !== receipt.task.sessionDigest) return false
  for (const pin of receipt.task.runs) {
    if (pin.sessionID !== receipt.sessionID) return false
    const histories = content.json.filter((item) => item.path === `raya/agent-runs/${pin.agentID}.json`)
    if (histories.length !== 1) return false
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Task.History))(histories[0].value, {
      onExcessProperty: "error",
    })
    if (Option.isNone(parsed)) return false
    const runs = parsed.value.runs.filter((run) => run.id === pin.id)
    if (runs.length !== 1) return false
    const run = runs[0]
    if (
      run.agentID !== pin.agentID ||
      run.sessionID !== pin.sessionID ||
      run.at !== pin.at ||
      (run.scheduleVersion ?? 1) !== pin.scheduleVersion ||
      !isDeepStrictEqual(run.trigger, pin.trigger) ||
      Reflect.get(identity, "agentID") !== pin.agentID ||
      Reflect.get(identity, "runID") !== pin.id ||
      Reflect.get(identity, "scheduleVersion") !== pin.scheduleVersion ||
      !isDeepStrictEqual(Reflect.get(identity, "trigger"), pin.trigger)
    )
      return false
    if (receipt.phase === "finished" && run.status !== "complete" && run.status !== "error") return false
  }
  return true
}
