import { expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { digest, entries, identity, source } from "../../src/kilocode/second-brain/capture-source"
import { valid } from "../../src/kilocode/second-brain/reply"
import { RequestID, type Request } from "../../src/kilocode/second-brain/protocol"
import { asSchema } from "ai"
import { extraction, extracted, prepared } from "../../src/kilocode/second-brain/capture-extraction"

const sid = SessionID.make("ses_capture")
const uid = MessageID.make("msg_user")
const aid = MessageID.make("msg_assistant")
const stamp = Date.parse("2026-10-09T01:30:00Z")
test("source references resolve original UTF-16 spans without splitting Unicode or accepting foreign evidence", () => {
  const original = {
    user: { id: uid, text: "😀 I prefer quiet notifications." },
    assistant: { id: aid, text: "Acknowledged." },
    tools: [],
  }
  const entry = {
    category: "Preferences",
    key: "quiet-notifications",
    text: "Prefers quiet notifications.",
    origin: "user_statement",
    evidence: [{ ref: 0 }],
  }
  const parsed = extracted({ entries: [entry] }, original)
  expect(parsed[0].evidence).toEqual([{ id: uid, start: 0, end: 32 }])
  expect(entries(parsed, original)).toHaveLength(1)
  const long = { ...original, user: { id: uid, text: "a".repeat(1023) + "😀b" } }
  const blocks = JSON.parse(prepared(long))
  expect(blocks[0].text).toBe("a".repeat(1023))
  expect(blocks[1].text).toBe("😀b")
  expect(extracted({ entries: [{ ...entry, evidence: [{ ref: 1 }] }] }, long)[0].evidence).toEqual([
    { id: uid, start: 1023, end: 1026 },
  ])
  for (const evidence of [[{ ref: 1 }], [{ ref: 42 }], [{ ref: "0" }], [{ ref: 0, id: "foreign" }]])
    expect(() => extracted({ entries: [{ ...entry, evidence }] }, original)).toThrow()
})
test("native extraction schema preserves every bound while rejecting excess output fields", async () => {
  const original = source(messages(), sid, aid)!.source
  const schema = await asSchema(extraction(original)).jsonSchema
  expect(schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      entries: {
        type: "array",
        maxItems: 8,
        items: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                key: { pattern: "^[a-z0-9][a-z0-9_-]{0,79}$" },
                text: { minLength: 1, maxLength: 4096 },
                evidence: {
                  minItems: 1,
                  maxItems: 4,
                  items: {
                    additionalProperties: false,
                    properties: {
                      ref: { enum: [0] },
                    },
                  },
                },
              },
            },
            {
              additionalProperties: false,
              properties: {
                origin: { enum: ["assistant_interpretation"] },
                evidence: { items: { properties: { ref: { enum: [1] } } } },
              },
            },
          ],
        },
      },
    },
  })
  expect(JSON.stringify(schema)).not.toContain('"allOf"')
  expect(extracted({ entries: [] }, original)).toEqual([])
  expect(() => extracted({ entries: [], private_field: "secret value" }, original)).toThrow("bounded entry schema")
  expect(() =>
    extracted(
      {
        entries: [
          {
            category: "Preferences",
            key: "bad key",
            text: "Preference",
            origin: "user_statement",
            evidence: [{ ref: 0 }],
          },
        ],
      },
      original,
    ),
  ).toThrow("bounded entry schema")
})
function text(id: MessageID, body: string): MessageV2.TextPart {
  return { id: PartID.make(`prt_${id}`), sessionID: sid, messageID: id, type: "text", text: body }
}
function messages(): MessageV2.WithParts[] {
  return [
    {
      info: {
        id: uid,
        sessionID: sid,
        role: "user",
        time: { created: stamp - 1000 },
        agent: "ask",
        model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("qwen") },
      },
      parts: [text(uid, "I prefer dim warm lights.")],
    },
    {
      info: {
        id: aid,
        sessionID: sid,
        role: "assistant",
        parentID: uid,
        time: { created: stamp - 500, completed: stamp },
        modelID: ModelV2.ID.make("qwen"),
        providerID: ProviderV2.ID.make("local"),
        mode: "ask",
        agent: "ask",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [text(aid, "I changed the lights.")],
    },
  ]
}

test("capture binds the stored original reply and excludes queued successor content", () => {
  const rows = messages()
  const next = messages().map((row) => ({
    ...row,
    info: { ...row.info, id: MessageID.make(`msg_next_${row.info.id}`) },
  }))
  const original = source([...rows, ...next], sid, aid)!
  expect(original.observed_utc).toBe("2026-10-09T01:30:00.000Z")
  expect(original.source.user.id).toBe(uid)
  expect(original.source.assistant.id).toBe(aid)
  expect(original.source_sha256).toBe(source(rows, sid, aid)!.source_sha256)
})

test("unfinished, summary, foreign and absent original replies are not captured", () => {
  for (const change of [
    { finish: undefined },
    { summary: true },
    { sessionID: SessionID.make("ses_other") },
    { time: { created: stamp } },
  ]) {
    const rows = messages()
    if (rows[1].info.role !== "assistant") throw new Error("Assistant fixture required")
    rows[1] = { ...rows[1], info: { ...rows[1].info, ...change } }
    expect(source(rows, sid, aid)).toBeUndefined()
  }
  expect(source(messages(), sid, "absent")).toBeUndefined()
})

test("synthetic text is excluded and credentialed source is redacted before extraction", () => {
  const rows = messages()
  rows[0].parts = [
    text(uid, "git clone https://alice:password@example.com/repo"),
    { ...text(uid, "Hidden instruction"), synthetic: true },
  ]
  const original = source(rows, sid, aid)!
  expect(original.source.user.text).not.toContain("password")
  expect(original.source.user.text).not.toContain("Hidden instruction")
})

test("assistant action claims cannot be relabelled as tool observations", () => {
  const original = source(messages(), sid, aid)!
  const entry = {
    category: "Preferences",
    key: "lights",
    text: "Prefers dim lights.",
    origin: "user_statement",
    evidence: [{ id: uid, start: 0, end: 10 }],
  }
  expect(entries([entry], original.source)).toHaveLength(1)
  expect(() =>
    entries([{ ...entry, origin: "tool_observation", evidence: [{ id: aid, start: 0, end: 10 }] }], original.source),
  ).toThrow()
  expect(() => entries([{ ...entry, evidence: [{ id: uid, start: 0, end: 10000 }] }], original.source)).toThrow()
  expect(() => entries([entry, entry], original.source)).toThrow()
})

test("oversized source is explicitly omitted instead of silently truncated", () => {
  const rows = messages()
  rows[0].parts = [text(uid, "a".repeat(16001))]
  expect(() => source(rows, sid, aid)).toThrow("Personal capture omitted")
})

test("failed tool evidence keeps its status and foreign parts are excluded", () => {
  const rows = messages()
  const tool: MessageV2.ToolPart = {
    id: PartID.make("prt_failed"),
    sessionID: sid,
    messageID: aid,
    type: "tool",
    callID: "call_failed",
    tool: "home_assistant",
    state: { status: "error", input: {}, error: "Device unavailable", time: { start: stamp - 400, end: stamp - 300 } },
  }
  rows[1].parts.push(tool, { ...tool, id: PartID.make("prt_foreign"), sessionID: SessionID.make("ses_other") })
  const original = source(rows, sid, aid)!
  expect(original.source.tools).toEqual([
    { id: tool.id, name: "home_assistant", status: "error", text: "Device unavailable" },
  ])
  expect(
    entries(
      [
        {
          category: "Daily",
          key: "light-failure",
          text: "Device reported unavailable.",
          origin: "tool_observation",
          evidence: [{ id: tool.id, start: 0, end: 18 }],
        },
      ],
      original.source,
    ),
  ).toHaveLength(1)
})

test("aggregate UTF-8 limit rejects Unicode sources below individual character limits", () => {
  const rows = messages()
  rows[0].parts = [text(uid, "界".repeat(8100))]
  expect(() => source(rows, sid, aid)).toThrow("Personal capture omitted")
})

test("framed identity resists field-boundary collisions and changed evidence changes digest", () => {
  expect(identity("a", "bc", "d")).not.toBe(identity("ab", "c", "d"))
  expect(identity("a", "bc", "d")).toMatch(/^[a-f0-9-]{14}5[a-f0-9]{3}-[89ab]/)
  const original = source(messages(), sid, aid)!
  expect(
    digest(original.observed_utc, {
      ...original.source,
      tools: [{ id: "t", name: "light", status: "error", text: "Unavailable" }],
    }),
  ).not.toBe(original.source_sha256)
})

test("capture policy replies require original identity and a current enabled grant", () => {
  const original = source(messages(), sid, aid)!
  const request: Request = {
    id: RequestID.make("sbr_capture"),
    project: "/repo",
    sessionID: sid,
    command: { action: "capturePolicy", messageID: aid, source_sha256: original.source_sha256 },
  }
  const reply = {
    action: "capturePolicy" as const,
    project: "/repo",
    sessionID: sid,
    messageID: aid,
    source_sha256: original.source_sha256,
    enabled: false,
  }
  expect(valid(request, reply)).toBe(true)
  expect(valid(request, { ...reply, messageID: "foreign" })).toBe(false)
  expect(valid(request, { ...reply, enabled: true })).toBe(false)
})
