import { expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import * as OllamaPrompt from "@/kilocode/provider/ollama-prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTransform } from "@/provider/transform"
import { ProviderTest } from "../fake/provider"

test("actual environment injection keeps authored text intact and separates SDK/native metadata while retaining cache placement", async () => {
  const sid = SessionID.make("ses_env_boundary")
  const uid = MessageID.make("msg_env_boundary")
  const text = "Reply exactly NONCE."
  const part: MessageV2.TextPart = {
    id: PartID.make("prt_env_boundary"),
    sessionID: sid,
    messageID: uid,
    type: "text",
    text,
  }
  const before = structuredClone(part)
  const user: MessageV2.User = {
    id: uid,
    sessionID: sid,
    role: "user",
    time: { created: 1 },
    agent: "ask",
    model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
  }
  const msgs: MessageV2.WithParts[] = [{ info: user, parts: [part] }]
  const block = "<environment_details>\nWorking directory: /fixture\n</environment_details>"
  KiloSessionPrompt.injectEditorContext({ msgs, lastUser: user, sessionID: sid, cache: { user: uid, block } })
  expect(part).toEqual(before)
  expect(msgs[0].parts[0]).toBe(part)
  const injected = msgs[0].parts[1]
  expect(injected).toMatchObject({ type: "text", text: "\n\n" + block, synthetic: true })
  const model = ProviderTest.model({
    api: { id: "fixture", url: "http://127.0.0.1:11434/v1", npm: "@ai-sdk/openai-compatible" },
  })
  const converted = await MessageV2.toModelMessages(msgs, model)
  const native = await OllamaPrompt.prepare(
    { localInference: true, localInferenceAPI: "ollama" },
    model,
    converted,
    {},
    "none",
  )
  expect(native?.messages.find((row) => row.role === "user")?.content).toBe(text + "\n\n" + block)
  expect(part).toEqual(before)
  const cached = ProviderTransform.message(
    structuredClone(converted),
    ProviderTest.model({
      id: ModelV2.ID.make("gpt-5.6"),
      api: { id: "gpt-5.6", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    }),
    {},
  )[0]
  if (!Array.isArray(cached.content)) throw new Error("Actual converted content parts required")
  const first = cached.content[0]
  const last = cached.content[1]
  if (first?.type !== "text" || last?.type !== "text") throw new Error("Actual converted text parts required")
  expect(first.providerOptions?.openai).toEqual({ promptCacheBreakpoint: { mode: "explicit" } })
  expect(last.providerOptions?.openai).toBeUndefined()
})
