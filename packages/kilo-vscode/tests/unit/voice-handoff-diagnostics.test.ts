import { expect, test } from "bun:test"
import { VoiceReplies } from "../../src/speech/replies"
import { diagnostics, type PlaybackDiagnostic } from "../../src/speech/diagnostics"

const first = "9a1d6a7d-8387-4381-b9bf-e7bfda2d66c3"
const second = "f646737d-3e15-4bc1-8e86-0505d460ee81"

test("actual reply handoff reports readiness without exposing source content or identities", async () => {
  const rows: PlaybackDiagnostic[] = []
  const replies = new VoiceReplies((row) => rows.push(row))
  replies.mark({ requestId: first, sessionID: "private-session" })
  const waiting = replies.wait("private-session")
  replies.message("private-session", "assistant", "private-assistant", "private-user", true)
  expect(replies.bind("private-session", "private-user", first)).toBe(true)
  replies.message("private-session", "assistant", "private-assistant", "private-user", true)
  await Promise.resolve()
  replies.part("private-session", {
    id: "private-part",
    messageID: "private-assistant",
    type: "text",
    text: "private transcript",
  })
  await Promise.resolve()
  replies.part("private-session", {
    id: "private-part",
    messageID: "private-assistant",
    type: "text",
    text: "private transcript",
    time: { end: 1 },
  })
  const reply = await waiting
  expect(reply?.text).toBe("private transcript")
  expect(rows.some((row) => row.reason === "unbound")).toBe(true)
  expect(rows.some((row) => row.reason === "missing-text")).toBe(true)
  expect(rows.some((row) => row.reason === "unended")).toBe(true)
  expect(rows.filter((row) => row.boundary === "consume")).toHaveLength(1)
  expect(replies.complete("private-session")).toBeUndefined()
  expect(JSON.stringify(rows)).not.toContain("private")
  expect(rows.every((row) => row.request === first)).toBe(true)
})

test("cancellation and replacement settle original waiters without later old-request observations", async () => {
  const rows: PlaybackDiagnostic[] = []
  const replies = new VoiceReplies((row) => rows.push(row))
  replies.mark({ requestId: first, sessionID: "session" })
  const original = replies.wait("session")
  replies.mark({ requestId: second, sessionID: "session" })
  expect(await original).toBeUndefined()
  const count = rows.filter((row) => row.request === first).length
  expect(replies.bind("session", "old-user", first)).toBe(false)
  replies.cancel(first)
  expect(rows.filter((row) => row.request === first)).toHaveLength(count)
  const current = replies.wait("session")
  replies.cancel(second)
  expect(await current).toBeUndefined()
  const end = rows.length
  replies.message("session", "assistant", "old-message", "old-user", true)
  replies.part("session", { id: "old-part", messageID: "old-message", type: "text", text: "private", time: { end: 1 } })
  expect(rows).toHaveLength(end)
  expect(rows.some((row) => row.request === first && row.reason === "replaced")).toBe(true)
  expect(rows.some((row) => row.request === second && row.reason === "cancelled")).toBe(true)
})

test("observer failure and invalid playback identity do not change actual reply admission", () => {
  const rows: PlaybackDiagnostic[] = []
  const invalid = new VoiceReplies((row) => rows.push(row))
  expect(invalid.mark({ requestId: "private-invalid", sessionID: "session" })).toBe(true)
  invalid.bind("session", "user", "private-invalid")
  invalid.message("session", "assistant", "message", "user", true)
  invalid.part("session", { id: "part", messageID: "message", type: "text", text: "reply", time: { end: 1 } })
  expect(invalid.complete("session")?.text).toBe("reply")
  expect(rows).toHaveLength(0)
  const replies = new VoiceReplies(() => {
    throw new Error("private observer cause")
  })
  expect(() => replies.mark({ requestId: first, sessionID: "session" })).not.toThrow()
  expect(replies.bind("session", "user", first)).toBe(true)
  replies.cancel()
})

test("handoff diagnostic boundary keeps the original finite whitelist and refuses arbitrary metadata", () => {
  const rows: PlaybackDiagnostic[] = []
  const trace = diagnostics(first, (row) => rows.push(row))
  const fields = {
    boundary: "private boundary",
    reason: "private reason",
    sessionID: "private session",
    text: "private transcript",
    ended: "private",
    failed: "private",
    parts: Infinity,
  } as unknown as Parameters<typeof trace>[1]
  for (let index = 0; index < 200; index++) trace("handoff", fields)
  expect(rows).toHaveLength(128)
  expect(JSON.stringify(rows)).not.toContain("private")
  expect(rows.every((row) => Object.keys(row).sort().join() === "elapsed,phase,request")).toBe(true)
})
