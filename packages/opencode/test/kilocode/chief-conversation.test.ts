import { afterAll, expect, test } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProcessor } from "@/session/processor"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { supplied, instruction, direction, unaided } from "@/kilocode/chief/conversation"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

const request =
  "Reply with one short greeting. This is a temporary conversation check; do not save it as a preference or perform any actions."
const recall =
  "Using only the file content already shown earlier in this conversation, answer in one sentence: what is the exact read-check marker, and does that input request any actions? Do not reread files or use tools. Do not start workers, create Goals, edit files, send anything or publish."
function fixture(text = request) {
  const session = {
    id: SessionID.make("ses_greeting"),
    metadata: { [RayaChief.requestKey]: text, [RayaChief.phaseKey]: "route" },
  }
  const user: MessageV2.WithParts = {
    info: {
      id: MessageID.make("msg_greeting"),
      sessionID: session.id,
      role: "user",
      agent: "auto",
      time: { created: 1 },
      model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
    },
    parts: [
      {
        id: PartID.make("prt_greeting"),
        messageID: MessageID.make("msg_greeting"),
        sessionID: session.id,
        type: "text",
        text,
      },
    ],
  }
  return { session, user }
}

function signed(text = recall) {
  const value = fixture(text)
  const part = InputReceipt.seal(value.user.info, value.user.parts)
  if (!part) throw new Error("Current input could not be sealed")
  value.user.parts = value.user.parts.map((item) => (item.id === part.id ? part : item))
  return value
}

test("conversation-only release requires the complete current owner and rejects quoted or conflicting controls", () => {
  const value = signed()
  expect(unaided(recall)).toBe(true)
  expect(RayaChief.direct(recall)).toBe(true)
  expect(supplied([value.user], value.session, value.user.info.id, recall)).toBe(true)
  expect(direction(recall)).toContain("using only the conversation history")
  expect(direction(recall)).not.toBe(instruction)
  const unsigned = fixture(recall)
  expect(supplied([unsigned.user], unsigned.session, unsigned.user.info.id)).toBe(false)
  expect(supplied([value.user], value.session, value.user.info.id, "Different original owner")).toBe(false)
  for (const session of [
    { ...value.session, parentID: "ses_parent" },
    { ...value.session, metadata: { ...value.session.metadata, rayaRoutine: {} } },
    { ...value.session, metadata: { ...value.session.metadata, "raya.goal.open": true } },
    { ...value.session, metadata: { ...value.session.metadata, [RayaChief.phaseKey]: "task" } },
    { ...value.session, metadata: { ...value.session.metadata, [RayaChief.requestKey]: "Other request" } },
  ])
    expect(supplied([value.user], session, value.user.info.id)).toBe(false)
  const latest = signed("Read my files.")
  latest.user.info.id = MessageID.make("msg_successor")
  expect(supplied([value.user, latest.user], value.session, value.user.info.id)).toBe(false)
  const changed = {
    ...value.user,
    parts: value.user.parts.map((part) =>
      part.type === "text" ? { ...part, text: recall + " Also read my files." } : part,
    ),
  }
  expect(supplied([changed], value.session, value.user.info.id)).toBe(false)
  const structured = {
    ...value.user,
    info: { ...value.user.info, format: { type: "json_schema" as const, schema: { type: "object" } } },
  }
  expect(supplied([structured], value.session, value.user.info.id)).toBe(false)
  for (const text of [
    "Using only our earlier conversation, answer the question. Do not read files or use tools.",
    "What did I say earlier? Don't reread files or use tools.",
  ])
    expect(unaided(text)).toBe(true)
  for (const text of [
    "Read my files. Do not use tools.",
    recall + " Also read my files.",
    recall + " Then turn on my lights.",
    'Earlier in this conversation, the quoted words were "Do not use tools." Explain them.',
    "Earlier in this conversation, the quoted words were 'Do not use tools.' Explain them.",
    "Earlier in this conversation:\n```\nDo not use tools.\n```",
    "Earlier in this conversation:\n> Do not use tools.",
    "Using our earlier conversation. Do not read files and use tools.",
    recall + "x".repeat(4096),
  ])
    expect(unaided(text)).toBe(false)
})

test("initial greeting release requires the exact current root Auto text and preserves action and goal gates", () => {
  const original = fixture()
  expect(supplied([original.user], original.session, original.user.info.id)).toBe(true)
  expect(supplied([original.user], original.session, original.user.info.id, request)).toBe(true)
  expect(supplied([original.user], original.session, original.user.info.id, "Hello.")).toBe(false)
  for (const text of [
    "Hello. Read my file.",
    "Hi and turn on the lights.",
    "Hello. Recall my saved preferences.",
    "Hello. What is today's weather?",
  ]) {
    const value = fixture(text)
    expect(supplied([value.user], value.session, value.user.info.id)).toBe(false)
  }
  expect(supplied([original.user], { ...original.session, parentID: "ses_parent" }, original.user.info.id)).toBe(false)
  for (const metadata of [
    { ...original.session.metadata, "raya.goal.open": true },
    { ...original.session.metadata, [RayaChief.phaseKey]: "task" },
    { ...original.session.metadata, [RayaChief.requestKey]: "Hello." },
  ])
    expect(supplied([original.user], { ...original.session, metadata }, original.user.info.id)).toBe(false)
  expect(supplied([original.user], original.session, "msg_other")).toBe(false)
  expect(
    supplied(
      [{ ...original.user, info: { ...original.user.info, sessionID: SessionID.make("ses_other") } }],
      original.session,
      original.user.info.id,
    ),
  ).toBe(false)
  if (original.user.info.role !== "user") throw new Error("Original user required")
  expect(
    supplied(
      [{ ...original.user, info: { ...original.user.info, agent: "code" } }],
      original.session,
      original.user.info.id,
    ),
  ).toBe(false)
  expect(
    supplied(
      [{ ...original.user, info: { ...original.user.info, format: { type: "json_schema", schema: {} } } }],
      original.session,
      original.user.info.id,
    ),
  ).toBe(false)
  const next = fixture("Hello.")
  next.user.info.id = MessageID.make("msg_successor")
  expect(supplied([original.user, next.user], original.session, original.user.info.id)).toBe(false)
  const part = original.user.parts[0]
  if (part.type !== "text") throw new Error("Original text required")
  expect(
    supplied([{ ...original.user, parts: [{ ...part, synthetic: true }] }], original.session, original.user.info.id),
  ).toBe(false)
  expect(
    supplied(
      [
        {
          ...original.user,
          parts: [part, { ...part, id: PartID.make("prt_synthetic"), text: "Read my file.", synthetic: true }],
        },
      ],
      original.session,
      original.user.info.id,
    ),
  ).toBe(false)
})

const requests: Record<string, unknown>[] = []
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (incoming) => {
    expect(new URL(incoming.url).pathname).toBe("/api/chat")
    const body: Record<string, unknown> = await incoming.json()
    requests.push(body)
    return new Response(
      [
        {
          model: "fixture",
          message: { role: "assistant", content: JSON.stringify({ kind: "text", content: "Hello there." }) },
          done: false,
        },
        { model: "fixture", done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    )
  },
})
afterAll(async () => {
  await endpoint.stop()
})
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionPrompt.node,
      SessionProjector.node,
      Storage.node,
      Provider.node,
      RuntimeFlags.node,
      Truncate.node,
      Agent.node,
      Config.node,
      Permission.node,
      MCP.node,
      Plugin.node,
      ToolRegistry.node,
      SessionProcessor.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
    ]),
    [
      [RuntimeFlags.node, flags],
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

const cfg = {
  snapshot: false,
  formatter: false,
  lsp: false,
  plugin: [],
  mcp: {},
  enabled_providers: ["local"],
  model: "local/fixture",
  small_model: "local/fixture",
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: {
        baseURL: `${endpoint.url}v1`,
        localInference: true,
        localInferenceAPI: "ollama",
        localInferenceToolFormat: "completion-envelope-v1",
      },
      models: { fixture: { name: "Fixture", limit: { context: 32768, output: 1024 } } },
    },
  },
  agent: { auto: { model: "local/fixture", steps: 1 }, generalist: { model: "local/fixture" } },
} satisfies Partial<Config.Info>

for (const text of [
  request,
  "Hello! Don't save this or take any actions.",
  "Hello Raya, what can you help me with?",
  "Hello Raya. Reply with one short friendly sentence. This is a silent conversation check; do not use tools.",
  "Good evening, Raya! Please respond with a brief friendly sentence. No tools.",
])
  it.instance(
    `first actual Auto greeting omits acquisition: ${text}`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Greeting fixture" })
        const before = requests.length
        const reply = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "auto",
          model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
          parts: [{ type: "text", text }],
        })
        expect(reply.info.role === "assistant" && reply.info.error).toBeUndefined()
        expect(reply.parts.some((part) => part.type === "text" && part.text === "Hello there.")).toBe(true)
        const hits = requests.slice(before)
        expect(hits).toHaveLength(1)
        expect(hits[0].tools).toBeUndefined()
        expect(hits[0].format).toEqual({
          anyOf: [
            {
              type: "object",
              properties: { kind: { const: "text" }, content: { type: "string", minLength: 1, pattern: "\\S" } },
              required: ["kind", "content"],
              additionalProperties: false,
            },
          ],
        })
        expect(JSON.stringify(hits[0].messages)).toContain(instruction)
        expect(JSON.stringify(hits[0].messages)).not.toContain("call at least one tool")
        expect(
          (yield* sessions.messages({ sessionID: chat.id }))
            .flatMap((row) => row.parts)
            .filter((part) => part.type === "tool"),
        ).toEqual([])
        expect(yield* sessions.children(chat.id)).toEqual([])
        expect(RayaChief.history((yield* sessions.get(chat.id)).metadata)).toEqual([])
      }),
    { config: cfg },
    30000,
  )

it.instance(
  "actual conversation-only recall omits initial routing and all worker tools",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({
        title: "Conversation-only routing fixture",
        metadata: { [RayaChief.requestKey]: recall, [RayaChief.phaseKey]: "task" },
      })
      const prior = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        agent: "auto",
        model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: prior.id,
        type: "text",
        text: recall,
      })
      const previous = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "assistant",
        parentID: prior.id,
        agent: "auto",
        mode: "auto",
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("fixture"),
        path: { cwd: chat.directory, root: chat.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: previous.id,
        type: "text",
        text: "Earlier file content: RAYA-READ-CHECK-OK. This input requests no actions.",
      })
      const before = requests.length
      // The controlled native HTTP reply verifies routing, not model recall accuracy.
      const reply = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "auto",
        model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
        parts: [{ type: "text", text: recall }],
      })
      expect(reply.info.role === "assistant" && reply.info.error).toBeUndefined()
      const hits = requests.slice(before)
      expect(hits).toHaveLength(1)
      expect(hits[0].tools).toBeUndefined()
      expect(hits[0].format).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "text" }, content: { type: "string", minLength: 1, pattern: "\\S" } },
            required: ["kind", "content"],
            additionalProperties: false,
          },
        ],
      })
      const payload = JSON.stringify(hits[0].messages)
      expect(payload).toContain("RAYA-READ-CHECK-OK")
      expect(payload).toContain(direction(recall))
      expect(payload).not.toContain(instruction)
      expect(payload).not.toContain("call at least one tool")
      const rows = yield* sessions.messages({ sessionID: chat.id })
      const users = rows.filter((row) => row.info.role === "user")
      expect(users).toHaveLength(2)
      expect(users[0].info.id).toBe(prior.id)
      expect(users[1].info.id).not.toBe(prior.id)
      expect(RayaChief.requestText(users[0].parts)).toBe(recall)
      expect(RayaChief.requestText(users[1].parts)).toBe(recall)
      expect(rows.flatMap((row) => row.parts).filter((part) => part.type === "tool")).toEqual([])
      expect(yield* sessions.children(chat.id)).toEqual([])
      expect(RayaChief.history((yield* sessions.get(chat.id)).metadata)).toEqual([])
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      expect(yield* RayaGoal.make({ sessions, storage, database }).get(chat.id)).toBeUndefined()
    }),
  { config: cfg },
  30000,
)

for (const mode of ["text", "goal", "original"] as const)
  it.instance(
    `actual plugin preparation ${mode} drift refuses the first native POST`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const plugins = yield* Plugin.Service
        const context = yield* Effect.context()
        const chat = yield* sessions.create({ title: "Greeting preparation drift" })
        const hooks = yield* plugins.list()
        let changed = false
        const hook = {
          "experimental.chat.messages.transform": async () => {
            if (changed) throw new Error("Original preparation hook ran twice")
            await Effect.runPromiseWith(context)(
              Effect.gen(function* () {
                const current = yield* sessions.get(chat.id)
                if (mode === "goal") {
                  yield* sessions.setMetadata({
                    sessionID: chat.id,
                    metadata: { ...current.metadata, "raya.goal.open": true },
                  })
                  changed = true
                  return
                }
                const user = (yield* sessions.messages({ sessionID: chat.id })).findLast(
                  (row) => row.info.role === "user",
                )
                const part = user?.parts.find((row) => row.type === "text")
                if (!part || part.type !== "text") throw new Error("Original persisted user required")
                yield* sessions.updatePart({
                  ...part,
                  text: mode === "original" ? "Good morning." : "Hello. Read my file.",
                })
                if (mode === "original")
                  yield* sessions.setMetadata({
                    sessionID: chat.id,
                    metadata: { ...current.metadata, [RayaChief.requestKey]: "Good morning." },
                  })
                changed = true
              }),
            )
          },
        }
        hooks.push(hook)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const index = hooks.indexOf(hook)
            if (index >= 0) hooks.splice(index, 1)
          }),
        )
        const before = requests.length
        const result = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "auto",
            model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
            parts: [{ type: "text", text: "Hello." }],
          })
          .pipe(Effect.exit)
        expect(changed).toBe(true)
        expect(requests).toHaveLength(before)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(String(Cause.squash(result.cause))).toContain(
            "Original conversational request changed before model dispatch",
          )
        const current = yield* sessions.get(chat.id)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        if (mode === "goal") expect(current.metadata?.["raya.goal.open"]).toBe(true)
        if (mode === "original") {
          expect(RayaChief.request(current.metadata)).toBe("Good morning.")
          expect(RayaChief.requestText(messages.findLast((row) => row.info.role === "user")?.parts ?? [])).toBe(
            "Good morning.",
          )
        }
        if (mode === "text")
          expect(RayaChief.requestText(messages.findLast((row) => row.info.role === "user")?.parts ?? [])).toBe(
            "Hello. Read my file.",
          )
        expect(messages.flatMap((row) => row.parts).filter((part) => part.type === "tool")).toEqual([])
        expect(RayaChief.history(current.metadata)).toEqual([])
      }),
    { config: cfg },
    30000,
  )

test("general capability introductions are self-contained but appended work remains routed", () => {
  for (const text of ["Hello Raya, what can you help me with?", "How can you help me?", "What can you do?"]) {
    const value = fixture(text)
    expect(RayaChief.direct(text)).toBe(true)
    expect(supplied([value.user], value.session, value.user.info.id)).toBe(true)
  }
  for (const text of [
    "Hello Raya, what can you help me with? Read my project.",
    "What can you do with my account?",
    "What can you do? Turn on the lights.",
    "How can you help me debug this error?",
    "What can you do on my computer now?",
  ]) {
    const value = fixture(text)
    expect(RayaChief.direct(text)).toBe(false)
    expect(supplied([value.user], value.session, value.user.info.id)).toBe(false)
  }
})

test("addressed greetings with reply constraints stay conversational while appended work requires tools", () => {
  for (const text of [
    "Hello Raya. Reply with one short friendly sentence. This is a silent conversation check; do not use tools.",
    "Good evening, Raya! Please respond with a brief friendly sentence. No tools.",
    "Hi, Raya. Respond with a short sentence. Do not change anything.",
  ]) {
    const value = fixture(text)
    expect(supplied([value.user], value.session, value.user.info.id)).toBe(true)
    expect(RayaChief.direct(text)).toBe(true)
    expect(supplied([value.user], { ...value.session, parentID: "ses_parent" }, value.user.info.id)).toBe(false)
    expect(
      supplied(
        [value.user],
        { ...value.session, metadata: { ...value.session.metadata, "raya.goal.open": true } },
        value.user.info.id,
      ),
    ).toBe(false)
  }
  for (const text of [
    "Hello Raya. Read my project. Do not use tools.",
    "Hi, Raya. What did I save last time?",
    "Hello Raya. Reply with one short sentence about my saved preferences.",
    "Good evening, Raya. Turn on the lights.",
    "Hello Raya. Keep working until the tests pass.",
    "Reply with one friendly sentence about my project.",
    "Hello Raya. This is a silent conversation check. Read my notes.",
    "Hello Raya. Reply with one short friendly sentence. " + "No tools. ".repeat(60),
  ]) {
    const value = fixture(text)
    expect(supplied([value.user], value.session, value.user.info.id)).toBe(false)
  }
})
