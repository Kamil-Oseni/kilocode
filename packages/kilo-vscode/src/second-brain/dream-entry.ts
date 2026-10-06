import type { BrainResponse } from "../shared/second-brain"

/** Only open native reviews; webview data cannot select input, model or publication authority. */
export async function entry(
  message: Record<string, unknown>,
  execute: (command: "raya.memory.startDream" | "raya.memory.inspectDream") => PromiseLike<unknown>,
  post: (response: BrainResponse) => void,
) {
  if (message.action !== "dreamStart" && message.action !== "dreamInspect") return false
  if (
    message.type !== "secondBrain" ||
    typeof message.id !== "string" ||
    !/^[a-z0-9-]{1,80}$/i.test(message.id) ||
    Object.keys(message).sort().join("|") !== "action|id|type"
  )
    return true
  const id = message.id
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
