// raya_change - verify Qwen-safe media delivery and visible degradation
import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { DashscopeMedia } from "@/kilocode/provider/dashscope-media"

function model(input: { providerID?: string; url?: string; image?: boolean } = {}) {
  return {
    id: "qwen3.8-max",
    providerID: input.providerID ?? "qwen",
    api: {
      id: "qwen3.8-max",
      npm: "@ai-sdk/openai-compatible",
      url: input.url ?? "https://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
    },
    capabilities: { input: { image: input.image ?? true } },
  } as unknown as Provider.Model
}

function messages(value: string): ModelMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "image", image: value, mediaType: "image/png" }],
    },
  ]
}

describe("DashscopeMedia", () => {
  test("preserves canonical inline images for Qwen", () => {
    const input = messages("data:image/png;base64,Zm9v")
    expect(DashscopeMedia.sanitize(input, model())).toEqual(input)
  })

  test("preserves in-memory image bytes for provider encoding", () => {
    const input = [
      {
        role: "user",
        content: [{ type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
      },
    ] as ModelMessage[]
    expect(DashscopeMedia.sanitize(input, model())).toEqual(input)
  })

  test.each(["file:///C:/preview.png", "http://127.0.0.1:5199/preview.png", "https://signed.example/expired"])(
    "replaces provider-inaccessible image URL %s with visible text",
    (url) => {
      const result = DashscopeMedia.sanitize(messages(url), model())
      expect(result).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Image attachment omitted because the Qwen endpoint cannot access its URL. Re-attach image attachment as an inline image.",
            },
          ],
        },
      ])
    },
  )

  test("reports image input disabled without sending media", () => {
    const result = DashscopeMedia.sanitize(messages("data:image/png;base64,Zm9v"), model({ image: false }))
    expect(result[0]?.content).toEqual([
      {
        type: "text",
        text: "ERROR: Cannot read image attachment because this Qwen model does not support image input. Inform the user.",
      },
    ])
  })

  test("leaves non-DashScope providers unchanged", () => {
    const input = messages("https://example.com/image.png")
    const other = model({ providerID: "other", url: "https://example.com/v1" })
    ;(other.api as { id: string }).id = "other"
    ;(other as { id: string }).id = "other"
    expect(DashscopeMedia.sanitize(input, other)).toEqual(input)
  })
})
