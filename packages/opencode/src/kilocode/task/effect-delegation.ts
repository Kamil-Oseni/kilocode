import { Effect } from "effect"
import { createHash } from "node:crypto"
import type { Session } from "@/session/session"
import type { SessionID, MessageID } from "@/session/schema"

export type Identity = Readonly<{
  sessionID: SessionID
  messageID: MessageID
  callID: string
  childSessionID: SessionID
  childMessageID: MessageID
}>

/** Evidence check only. These saved rows never mint an execution owner. */
export const inspect = (sessions: Session.Interface, input: Identity) =>
  Effect.gen(function* () {
    const rows = yield* sessions.messages({ sessionID: input.sessionID, limit: 129 })
    const parent = rows.find((row) => row.info.id === input.messageID)
    const calls = parent?.parts.filter((part) => part.type === "tool" && part.callID === input.callID) ?? []
    const call = calls[0]
    const child = yield* sessions.get(input.childSessionID)
    if (
      !parent ||
      parent.info.role !== "assistant" ||
      calls.length !== 1 ||
      !call ||
      call.type !== "tool" ||
      call.tool !== "task" ||
      (call.state.status !== "running" && call.state.status !== "completed") ||
      call.state.metadata?.sessionId !== input.childSessionID ||
      call.state.metadata?.childMessageID !== input.childMessageID ||
      child.parentID !== input.sessionID
    )
      throw new Error("Original Task delegation evidence is unavailable")
    const value = {
      identity: input,
      parent: { id: parent.info.id, parentID: parent.info.parentID, sessionID: parent.info.sessionID },
      call: { id: call.id, callID: call.callID, tool: call.tool, input: call.state.input },
      child: { id: child.id, parentID: child.parentID, created: child.time.created },
    }
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Original Task delegation evidence exceeds capacity")
    return createHash("sha256").update(text).digest("hex")
  })
