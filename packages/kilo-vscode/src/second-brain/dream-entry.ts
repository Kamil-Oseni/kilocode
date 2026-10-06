import type { BrainResponse } from "../shared/second-brain"
import { activity, identity } from "./dream-activity"

/** Only open native reviews; webview data cannot select input, model or publication authority. */
export async function entry(
  message: Record<string, unknown>,
  execute: (
    command:
      | "raya.memory.startDream"
      | "raya.memory.inspectDream"
      | "raya.memory.dreamActivity"
      | "raya.memory.cancelDream",
    target?: { id: string; owner: string },
  ) => PromiseLike<unknown>,
  post: (response: BrainResponse) => void,
) {
  if (!["dreamStart", "dreamInspect", "dreamActivity", "dreamCancel"].includes(String(message.action))) return false
  if (
    message.type !== "secondBrain" ||
    typeof message.id !== "string" ||
    !/^[a-z0-9-]{1,80}$/i.test(message.id) ||
    Object.keys(message).sort().join("|") !==
      (message.action === "dreamCancel" ? "action|id|target|type" : "action|id|type")
  )
    return true
  const id = message.id
  if (message.action === "dreamActivity" || message.action === "dreamCancel") {
    try {
      const target = message.action === "dreamCancel" ? identity.parse(message.target) : undefined
      const result = await execute(
        message.action === "dreamCancel" ? "raya.memory.cancelDream" : "raya.memory.dreamActivity",
        target,
      )
      const row = result === undefined ? undefined : activity.parse(result)
      post({
        type: "secondBrainState",
        id,
        state: { configured: false, status: "disconnected", results: [], dream: { status: "closed", activity: row } },
      })
    } catch (err) {
      console.warn("[Raya] Original consolidation activity is unavailable", err)
      post({
        type: "secondBrainState",
        id,
        state: { configured: false, status: "disconnected", results: [], dream: { status: "unavailable" } },
      })
    }
    return true
  }
  const send = (status: "native-review" | "closed" | "unavailable") =>
    post({
      type: "secondBrainState",
      id,
      state: { configured: false, status: "disconnected", results: [], dream: { status } },
    })
  send("native-review")
  try {
    await execute(message.action === "dreamStart" ? "raya.memory.startDream" : "raya.memory.inspectDream")
    // A cancelled picker also returns normally. This is not generation or publication success.
    send("closed")
  } catch (err) {
    console.warn("[Raya] Native consolidation review did not finish", err)
    send("unavailable")
  }
  return true
}
