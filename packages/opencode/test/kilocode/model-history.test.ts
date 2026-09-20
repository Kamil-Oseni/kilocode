import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { KiloModelHistory } from "@/kilocode/session/model-history"

describe("model history repair", () => {
  test("preserves valid messages", () => {
    const input = [{ role: "user", content: [{ type: "text", text: "hello" }] }] satisfies ModelMessage[]

    expect(KiloModelHistory.repair(input)).toEqual({ messages: input, repairs: [] })
  })

  test("strips invalid provider metadata without exposing its value", () => {
    const secret = "private-provider-payload"
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "safe answer",
            providerOptions: { [secret]: { invalid: () => secret } },
          },
        ],
      },
    ]

    const result = KiloModelHistory.repair(input)

    expect(result.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "safe answer" }] }])
    expect(result.repairs).toEqual([
      {
        path: "messages[0].content[0].providerOptions.*",
        role: "assistant",
        action: "metadata-stripped",
      },
    ])
    expect(JSON.stringify(result.repairs)).not.toContain(secret)
  })

  test("drops an irreparable historical message and reports only its path", () => {
    const secret = "private-invalid-content"
    const input = [
      { role: "user", content: [{ type: "text", text: "keep" }] },
      { role: "assistant", content: [{ type: "text", text: { secret } }] },
    ]

    const result = KiloModelHistory.repair(input)

    expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: "keep" }] }])
    expect(result.repairs).toEqual([
      { path: "messages[1].content[0].text", role: "assistant", action: "message-dropped" },
    ])
    expect(JSON.stringify(result.repairs)).not.toContain(secret)
  })
})
