import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Frames from "@/kilocode/desktop/frame-context"

function image(data = "cG5n") {
  return {
    type: "file",
    mime: "image/png",
    filename: "desktop.png",
    url: `data:image/png;base64,${data}`,
  } as SessionV1.FilePart
}

function history(session: string, call: string) {
  return [
    {
      info: { role: "assistant", sessionID: session },
      parts: [
        {
          type: "tool",
          callID: call,
          sessionID: session,
          state: { status: "completed", output: "observation receipt", attachments: undefined },
        },
      ],
    },
  ] as SessionV1.WithParts[]
}

describe("private desktop frame context", () => {
  test("delivers one model step without changing the persisted part or replaying", () => {
    const session = "ses_private_frame"
    const turn = "msg_private_frame"
    const call = "call_private_frame"
    const saved = history(session, call)
    expect(Frames.store({ session, turn, call, attachments: [image()] })).toEqual({ kept: 1, omitted: 0 })
    const frames = Frames.take(session, turn)
    const model = Frames.inject(saved, frames)
    expect(JSON.stringify(model)).toContain("data:image/png;base64,cG5n")
    expect(JSON.stringify(saved)).not.toContain("data:image/png")
    expect(Frames.isInjected(model[0].parts[0])).toBe(true)
    expect(Frames.isInjected(saved[0].parts[0])).toBe(false)
    expect(Frames.take(session, turn).size).toBe(0)
    expect(JSON.stringify(Frames.inject(saved, Frames.take(session, turn)))).not.toContain("data:image/png")
  })

  test("drops frames for a later user turn and another session", () => {
    const session = "ses_private_mismatch"
    Frames.store({ session, turn: "old", call: "call_mismatch", attachments: [image()] })
    expect(Frames.take("other", "old").size).toBe(0)
    expect(Frames.take(session, "new").size).toBe(0)
    expect(Frames.take(session, "old").size).toBe(0)
  })

  test("redacts image data URLs in tool text and nested metadata", () => {
    const text = "scene data:image/png;base64,cG5n done"
    expect(Frames.redact(text)).toBe("scene [private media omitted] done")
    expect(Frames.redactMetadata({ nested: [text] })).toEqual({ nested: ["scene [private media omitted] done"] })
  })

  test("bounds aggregate queued image bytes across sessions", () => {
    const data = "A".repeat(13 * 1024 * 1024)
    Frames.store({ session: "ses_budget_first", turn: "turn", call: "call_1", attachments: [image(data)] })
    Frames.store({ session: "ses_budget_second", turn: "turn", call: "call_2", attachments: [image(data)] })
    expect(Frames.take("ses_budget_first", "turn").size).toBe(0)
    expect(Frames.take("ses_budget_second", "turn").size).toBe(1)
  })
})
