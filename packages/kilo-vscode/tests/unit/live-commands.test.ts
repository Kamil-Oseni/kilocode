import { expect, test } from "bun:test"
import { LiveCommands } from "../../src/speech/live-commands"

test("LiveCommands correlates acknowledgement, reuse, errors and close without retrying", async () => {
  const sent: Record<string, unknown>[] = []
  const commands = new LiveCommands((event) => {
    sent.push(event)
  })
  const first = commands.append("mute_1", "session.input_audio.mute")
  expect(sent).toEqual([{ type: "session.input_audio.mute", event_id: "mute_1" }])
  expect(commands.append("mute_1", "session.input_audio.mute")).toBe(first)
  expect(await commands.append("mute_1", "session.input_audio.unmute")).toEqual({
    status: "failed",
    error: "Voice command identity was reused.",
  })
  expect(commands.receive({ type: "session.input_audio.muted", client_event_id: "other" })).toBe(false)
  expect(commands.receive({ type: "session.commentary.appended", client_event_id: "mute_1" })).toBe(false)
  expect(commands.receive({ type: "session.input_audio.muted", client_event_id: "mute_1" })).toBe(true)
  expect(await first).toEqual({ status: "accepted" })
  const comment = commands.append("note_1", "session.commentary.append", { content: "Clarify" })
  expect(sent.at(-1)).toEqual({ type: "session.commentary.append", event_id: "note_1", content: "Clarify" })
  expect(
    commands.receive({
      type: "error",
      error: { event_id: "note_1", code: "invalid_request" },
    }),
  ).toBe(true)
  expect(await comment).toEqual({ status: "failed", error: "OpenAI rejected the voice command." })
  const late = commands.append("note_2", "session.commentary.append", { content: "Later" })
  commands.close()
  expect(await late).toEqual({
    status: "unknown",
    error: "Voice ended before command acceptance was confirmed.",
  })
  expect(sent.filter((event) => event.event_id === "note_2")).toHaveLength(1)
})

test("LiveCommands treats a send failure as failed rather than unknown", async () => {
  const commands = new LiveCommands(() => {
    throw new Error("closed")
  })
  expect(await commands.append("mute_1", "session.input_audio.mute")).toEqual({
    status: "failed",
    error: "Voice command could not be sent.",
  })
})
