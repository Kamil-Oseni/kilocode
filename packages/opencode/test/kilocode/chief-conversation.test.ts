import { afterAll, expect, test } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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
import { supplied, instruction } from "@/kilocode/chief/conversation"
import { testEffect } from "../lib/effect"

const request =
  "Reply with one short greeting. This is a temporary conversation check; do not save it as a preference or perform any actions."
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
        { model: "fixture", message: { role: "assistant", content: "Hello there." }, done: false },
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
    [[RuntimeFlags.node, flags]],
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

for (const text of [request, "Hello! Don't save this or take any actions."])
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
        expect(hits[0].format).toBeUndefined()
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
          expect(String(Cause.squash(result.cause))).toContain("Original greeting changed before model dispatch")
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
