import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { KiloSession } from "../../src/kilocode/session"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"

describe("session close reason", () => {
  test("retained assistant cancellation remains interrupted after a successful runner return", () => {
    const error = new MessageV2.AbortedError({ message: "Aborted" }).toObject()
    expect(
      KiloSessionPrompt.resolveCloseReason({
        sessionID: "cancelled",
        closeReasons: new Map(),
        exit: Exit.succeed({ info: { role: "assistant", error } }),
      }),
    ).toBe("interrupted")
  })

  test("explicit superseded and error reasons retain priority and are consumed", () => {
    for (const reason of ["superseded", "error"] as const) {
      const reasons = new Map<string, KiloSession.CloseReason>([["explicit", reason]])
      expect(
        KiloSessionPrompt.resolveCloseReason({
          sessionID: "explicit",
          closeReasons: reasons,
          exit: Exit.succeed({
            info: { role: "assistant", error: new MessageV2.AbortedError({ message: "Aborted" }).toObject() },
          }),
        }),
      ).toBe(reason)
      expect(reasons.has("explicit")).toBe(false)
    }
  })

  test("other errors and malformed or non-assistant outputs do not invent interruption", () => {
    const error = new MessageV2.AbortedError({ message: "Aborted" }).toObject()
    for (const value of [
      undefined,
      {},
      { info: null },
      { info: { role: "user", error } },
      { info: { role: "assistant", error: { name: "MessageAbortedError", data: {} } } },
      { info: { role: "assistant", error: { name: "UnknownError", data: { message: "Failed" } } } },
      { info: { role: "assistant" } },
    ])
      expect(
        KiloSessionPrompt.resolveCloseReason({
          sessionID: "ordinary",
          closeReasons: new Map(),
          exit: Exit.succeed(value),
        }),
      ).toBe("completed")
  })

  test("actual interrupted and failed effects retain their distinct close reasons", async () => {
    const interrupted = await Effect.runPromiseExit(Effect.interrupt)
    expect(
      KiloSessionPrompt.resolveCloseReason({ sessionID: "interrupted", closeReasons: new Map(), exit: interrupted }),
    ).toBe("interrupted")
    expect(
      KiloSessionPrompt.resolveCloseReason({
        sessionID: "failed",
        closeReasons: new Map(),
        exit: Exit.fail(new Error("Failed")),
      }),
    ).toBe("error")
  })
})
