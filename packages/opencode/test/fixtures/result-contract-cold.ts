// kilocode_change - new file
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import z from "zod"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2 } from "@opencode-ai/core/event"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { drainFileLoggers } from "@opencode-ai/core/kilocode/file-logger"
import * as Log from "@opencode-ai/core/util/log"
import * as Outcome from "@opencode-ai/core/kilocode/background-outcome"
import { ResultNotice } from "@opencode-ai/core/kilocode/result-notice.sql"
import { BackgroundOutcome } from "@opencode-ai/core/kilocode/background-outcome.sql"
import { Committed } from "@opencode-ai/schema/kilocode/result-notice"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import * as NativeRuntime from "../../src/session/llm/native-runtime"
import { Provider } from "../../src/provider/provider"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Storage } from "../../src/storage/storage"
import { Git } from "../../src/git"
import { BackgroundJob } from "../../src/background/job"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { ResultContract } from "../../src/kilocode/chief/result-contract"
import * as Journal from "../../src/kilocode/background/outcome"
import * as Receipts from "../../src/kilocode/chief/notice-receipt"
import { references } from "../../src/kilocode/provider/result-contract"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const root = path.resolve(process.argv[2]!)
const operation = process.argv[3]
const mode = process.argv[4] ?? "success"
const state = { posts: 0, commits: 0, joined: 0, fault: false }
const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") }
const flags = RuntimeFlags.layer({
  experimentalNativeLlm: true,
  experimentalEventSystem: true,
  experimentalBackgroundSubagents: true,
})
const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const database = Database.layerFromPath(path.join(root, "durable.sqlite"))
const storage = Storage.layerFromDir(path.join(root, "storage"))
const finished = Effect.runSync(Deferred.make<void>())
const outcome = Layer.effect(
  Outcome.Service,
  Effect.gen(function* () {
    const original = yield* Journal.make(yield* Database.Service)
    return {
      ...original,
      joined: (writer: object, info: Parameters<Outcome.Interface["joined"]>[1]) =>
        Effect.gen(function* () {
          state.joined++
          if (mode === "terminal") {
            state.fault = true
            yield* Deferred.succeed(finished, undefined)
            return yield* Effect.fail(new Error("Owned terminal acknowledgement refused"))
          }
          return yield* original.joined(writer, info)
        }),
    } satisfies Outcome.Interface
  }),
)
const bridge = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const publish: typeof events.publish = (definition, data, options) =>
      Effect.gen(function* () {
        if (definition.type !== Committed.type) return yield* events.publish(definition, data, options)
        if (mode === "joined") {
          state.fault = true
          yield* Deferred.succeed(finished, undefined)
          return yield* Effect.die(new Error("Owned notice publication refused"))
        }
        const result = yield* events.publish(definition, data, options)
        state.commits++
        if (mode === "ack") {
          state.fault = true
          yield* Deferred.succeed(finished, undefined)
          return yield* Effect.die(new Error("Owned committed acknowledgement lost"))
        }
        yield* Deferred.succeed(finished, undefined)
        return result
      })
    return EventV2Bridge.Service.of({ ...events, publish })
  }),
).pipe(Layer.provide(EventV2Bridge.layer))
const layer = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionPrompt.node,
    SessionProcessor.node,
    SessionProjector.node,
    Provider.node,
    Config.node,
    Agent.node,
    Permission.node,
    Plugin.node,
    MCP.node,
    ToolRegistry.node,
    Truncate.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    Storage.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Journal.node,
    InstanceStore.node,
  ]),
  [
    [RuntimeFlags.node, flags],
    [Database.node, makeGlobalNode({ service: Database.Service, layer: database, deps: [] })],
    [Storage.node, LayerNode.make({ service: Storage.Service, layer: storage, deps: [FSUtil.node, Git.node] })],
    [InstanceStore.bootstrapNode, bootstrap],
    [Journal.node, LayerNode.make({ service: Outcome.Service, layer: outcome, deps: [Database.node] })],
    [EventV2Bridge.node, LayerNode.make({ service: EventV2Bridge.Service, layer: bridge, deps: [EventV2.node] })],
  ],
)

function refuse(value: unknown): asserts value {
  if (!value) throw new Error("Owned cold fixture invariant failed")
}

const configure = (url: string) =>
  Config.Service.use((cfg) =>
    cfg.update({
      snapshot: false,
      formatter: false,
      lsp: false,
      plugin: [],
      mcp: {},
      raya_routing: { confidence_threshold: 0 },
      permission: { "*": "deny", chief_route: "allow", task: "allow", read: "allow" },
      enabled_providers: ["openai"],
      model: "openai/fixture",
      small_model: "openai/fixture",
      provider: {
        openai: {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: {
            baseURL: `${url}v1`,
            apiKey: "owned-cold-loopback",
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 65536, output: 1024 } } },
        },
      },
      agent: { auto: { model: "openai/fixture", steps: 6 }, generalist: { model: "openai/fixture", steps: 4 } },
    }),
  )

const produce = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const jobs = yield* BackgroundJob.Service
  const original = yield* Outcome.Service
  const context = yield* Effect.context()
  const chat = yield* sessions.create({ title: "Actual cold background result" })
  const directory = path.join(root, "workspace", "observed")
  const request = `Use a read-only specialist to list the exact filenames in ${directory}. Return the names verbatim.`
  const phases = { parent: 0, child: 0 }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(incoming) {
          refuse(new URL(incoming.url).pathname === "/api/chat")
          const body = await incoming.json()
          if (++state.posts > 12) throw new Error("Owned cold provider capacity exceeded")
          const owner = !body.messages.some(
            (row: { role: string; content: string }) => row.role === "user" && row.content.includes("<subagent_brief>"),
          )
          const phase = owner ? phases.parent++ : phases.child++
          const value = await Effect.runPromiseWith(context)(
            Effect.gen(function* () {
              if (owner && phase === 0)
                return {
                  kind: "tool",
                  name: "chief_route",
                  arguments: { objective: request, access: "read", result: "directory_entries" },
                }
              if (owner && phase === 1)
                return {
                  kind: "tool",
                  name: "task",
                  arguments: {
                    description: "Actual cold inspection",
                    brief: { objective: request },
                    access: "read",
                    step_cap: 4,
                    background: true,
                  },
                }
              if (!owner && phase === 0) return { kind: "tool", name: "read", arguments: { filePath: directory } }
              const children = yield* sessions.children(chat.id)
              refuse(children.length === 1)
              const rows = yield* sessions.messages({ sessionID: children[0]!.id })
              const row = rows.findLast((row) =>
                row.parts.some(
                  (part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed",
                ),
              )
              const part = row?.parts.findLast(
                (part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed",
              )
              refuse(row && part?.type === "tool")
              return {
                kind: "text",
                content: JSON.stringify({
                  source: { sessionID: children[0]!.id, messageID: row.info.id, partID: part.id, callID: part.callID },
                  format: "directory_entries",
                }),
              }
            }),
          )
          return new Response(
            [
              { model: body.model, message: { role: "assistant", content: JSON.stringify(value) }, done: false },
              { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 32, eval_count: 8 },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n",
          )
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop()),
  )
  yield* configure(server.url.toString())
  const outcome = yield* prompt
    .prompt({ sessionID: chat.id, agent: "auto", model, parts: [{ type: "text", text: request }] })
    .pipe(Effect.exit)
  if (Exit.isFailure(outcome)) throw Cause.squash(outcome.cause)
  refuse(
    outcome.value.info.role === "assistant" && !outcome.value.info.error && outcome.value.info.finish === "tool-calls",
  )
  // The real child used eight seconds; allow both existing five-second ownership joins and publication.
  yield* Deferred.await(finished).pipe(Effect.timeout("20 seconds"))
  const children = yield* sessions.children(chat.id)
  refuse(children.length === 1)
  const job = yield* jobs.get(children[0]!.id)
  refuse(job?.revision && job.status === "completed")
  const retained = yield* original.get({ id: job.id, revision: job.revision })
  const rows = yield* sessions.messages({ sessionID: chat.id })
  const notices = rows.filter(
    (row) => row.info.role === "user" && row.parts.some((part) => part.type === "text" && part.synthetic),
  )
  refuse(mode === "terminal" ? retained?.phase === "terminal" : retained?.phase === "joined")
  refuse(notices.length === (mode === "terminal" || mode === "joined" ? 0 : 1))
  const receipt = notices[0]
    ? yield* Receipts.make(yield* Database.Service).get({ sessionID: chat.id, messageID: notices[0].info.id })
    : undefined
  refuse(mode === "terminal" || mode === "joined" ? !receipt : receipt)
  return {
    root: chat.id,
    child: children[0]!.id,
    notice: notices[0]?.info.id,
    revision: job.revision,
    phase: retained?.phase,
    receipt,
    state,
  }
})

const inspect = Effect.gen(function* () {
  const saved = JSON.parse(yield* Effect.promise(() => readFile(path.join(root, "producer.json"), "utf8")))
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  const id = SessionID.make(saved.root)
  const before = yield* sessions.messages({ sessionID: id })
  const receipt = saved.notice
    ? yield* Receipts.make(database).get({ sessionID: saved.root, messageID: saved.notice })
    : undefined
  const selected = yield* ResultContract.load(sessions, id).pipe(Effect.exit)
  refuse((yield* (yield* BackgroundJob.Service).list()).length === 0)
  if (!saved.notice) {
    refuse(!receipt && before.every((row) => !row.parts.some((part) => part.type === "text" && part.synthetic)))
    return {
      accepted: false,
      debt: true,
      unchanged: JSON.stringify(before) === JSON.stringify(yield* sessions.messages({ sessionID: id })),
      phase: saved.phase,
      posts: state.posts,
      rows: before.length,
    }
  }
  if (Exit.isFailure(selected)) throw Cause.squash(selected.cause)
  refuse(selected.value)
  yield* ResultContract.check(sessions, selected.value)
  // Cold receipt verification does not fabricate a parent continuation assistant.
  const child = yield* ResultContract.load(sessions, SessionID.make(saved.child))
  refuse(child && child.sessionID === selected.value.sessionID && child.userID === selected.value.userID)
  yield* ResultContract.check(sessions, child)
  const refs = yield* references(sessions, child)
  refuse(refs.length === 1)
  const reject = (effect: Effect.Effect<unknown, unknown>) =>
    Effect.gen(function* () {
      refuse(Exit.isFailure(yield* effect.pipe(Effect.exit)))
    })
  yield* reject(ResultContract.check(sessions, { ...selected.value }))
  const notice = before.find((row) => row.info.id === saved.notice)
  const part = notice?.parts[0]
  refuse(part?.type === "text")
  yield* sessions.updatePart({ ...part, text: "Owned same-ID notice tamper" })
  yield* reject(ResultContract.check(sessions, selected.value))
  yield* sessions.updatePart(part)
  yield* ResultContract.check(sessions, selected.value)
  yield* database.db
    .update(ResultNotice)
    .set({ sha: "0".repeat(64) })
    .where(eq(ResultNotice.messageID, saved.notice))
    .run()
    .pipe(Effect.orDie)
  yield* reject(ResultContract.check(sessions, selected.value))
  const raw = JSON.stringify(receipt)
  const { createHash } = yield* Effect.promise(() => import("node:crypto"))
  yield* database.db
    .update(ResultNotice)
    .set({ sha: createHash("sha256").update(raw).digest("hex") })
    .where(eq(ResultNotice.messageID, saved.notice))
    .run()
    .pipe(Effect.orDie)
  yield* ResultContract.check(sessions, selected.value)
  yield* database.db
    .update(BackgroundOutcome)
    .set({ terminalSHA: "0".repeat(64) })
    .where(eq(BackgroundOutcome.id, saved.child))
    .run()
    .pipe(Effect.orDie)
  yield* reject(ResultContract.check(sessions, selected.value))
  yield* database.db
    .update(BackgroundOutcome)
    .set({ terminalSHA: receipt!.job.terminalSHA })
    .where(eq(BackgroundOutcome.id, saved.child))
    .run()
    .pipe(Effect.orDie)
  yield* ResultContract.check(sessions, selected.value)
  const source = JSON.parse(refs[0]!)
  const children = yield* sessions.messages({ sessionID: SessionID.make(saved.child) })
  const read = children.flatMap((row) => row.parts).find((part) => part.id === source.source.partID)
  refuse(read?.type === "tool" && read.state.status === "completed")
  refuse(receipt!.source.reads.length === 1 && receipt!.source.reads[0]!.id === read.id)
  const entries = read.state.metadata.display.entries
  const inserted = yield* database.db
    .insert(ResultNotice)
    .values({
      sessionID: receipt!.root.sessionID,
      messageID: MessageID.ascending(),
      userID: receipt!.root.userID,
      jobID: receipt!.job.id,
      revision: receipt!.job.revision,
      callID: receipt!.job.callID,
      inputID: receipt!.job.inputID,
      body: JSON.stringify(receipt),
      sha: "0".repeat(64),
    })
    .run()
    .pipe(Effect.exit)
  refuse(Exit.isFailure(inserted))
  const fresh = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: id,
    role: "user",
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: fresh.id,
    sessionID: id,
    type: "text",
    text: "Owned newer authored request",
  })
  yield* reject(ResultContract.check(sessions, selected.value))
  yield* sessions.removeMessage({ sessionID: id, messageID: fresh.id })
  yield* ResultContract.check(sessions, selected.value)
  refuse(JSON.stringify(before) === JSON.stringify(yield* sessions.messages({ sessionID: id })))
  return {
    accepted: true,
    cold: true,
    finalGeneration: false,
    receipt: receipt!.row.messageID === saved.notice,
    refs,
    entries,
    posts: state.posts,
    copied: false,
    mutated: false,
    stale: false,
    duplicate: false,
    newer: false,
  }
})

const complete = Effect.gen(function* () {
  const saved = JSON.parse(yield* Effect.promise(() => readFile(path.join(root, "producer.json"), "utf8")))
  refuse(mode === "ack" && saved.notice && saved.state.commits === 1 && saved.state.fault)
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const jobs = yield* BackgroundJob.Service
  const database = yield* Database.Service
  const journal = yield* Outcome.Service
  const id = SessionID.make(saved.root)
  const rows = yield* sessions.messages({ sessionID: id })
  const children = yield* sessions.messages({ sessionID: SessionID.make(saved.child) })
  const receipt = yield* Receipts.make(database).get({ sessionID: id, messageID: saved.notice })
  const outcome = yield* journal.get({ id: saved.child, revision: saved.revision })
  refuse(receipt && outcome?.phase === "joined")
  refuse((yield* jobs.list()).length === 0)
  const original = yield* ResultContract.load(sessions, id)
  refuse(original)
  yield* ResultContract.check(sessions, original)
  const child = yield* ResultContract.load(sessions, SessionID.make(saved.child))
  refuse(child && child.sessionID === original.sessionID && child.userID === original.userID)
  yield* ResultContract.check(sessions, child)
  const refs = yield* references(sessions, child)
  refuse(refs.length === 1)
  const source = JSON.parse(refs[0]!)
  const read = children.flatMap((row) => row.parts).find((part) => part.id === source.source.partID)
  refuse(read?.type === "tool" && read.state.status === "completed" && read.tool === "read")
  refuse(receipt.source.reads.length === 1 && receipt.source.reads[0]!.id === read.id)
  const text = read.state.metadata.display.entries.join("\n")
  const answers = rows.filter((row) => row.info.role === "assistant" && row.info.parentID === saved.notice)
  refuse(answers.length <= 1)
  if (answers.length) {
    const answer = answers[0]!
    refuse(answer.info.role === "assistant" && !answer.info.error && answer.info.finish === "stop")
    refuse(
      answer.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") === text,
    )
  }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          refuse(new URL(request.url).pathname === "/api/chat" && request.method === "POST")
          const body = await request.json()
          refuse(++state.posts === 1 && body.model === "fixture" && body.stream === true)
          refuse(
            !body.messages.some(
              (row: { role: string; content: string }) =>
                row.role === "user" && row.content.includes("<subagent_brief>"),
            ),
          )
          const format = z
            .object({
              anyOf: z.array(
                z.object({
                  properties: z.object({
                    kind: z.object({ const: z.string() }),
                    content: z.object({ enum: z.array(z.string().max(8192)).max(128).optional() }).optional(),
                  }),
                }),
              ),
            })
            .parse(body.format)
          const branch = format.anyOf.find((item) => item.properties.kind.const === "text")
          refuse(JSON.stringify(branch?.properties.content?.enum) === JSON.stringify(refs))
          return new Response(
            [
              {
                model: body.model,
                message: { role: "assistant", content: JSON.stringify({ kind: "text", content: refs[0] }) },
                done: false,
              },
              { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 32, eval_count: 8 },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n",
          )
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop()),
  )
  yield* configure(server.url.toString())
  const provider = yield* Provider.Service
  const selected = yield* provider.getModel(model.providerID, model.modelID)
  const owned = yield* provider.getProvider(model.providerID)
  refuse(NativeRuntime.status({ model: selected, provider: owned, auth: undefined }).type === "supported")
  const final = yield* prompt.loop({ sessionID: id })
  refuse(
    final.info.role === "assistant" &&
      !final.info.error &&
      final.info.finish === "stop" &&
      final.info.parentID === saved.notice,
  )
  refuse(
    final.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") === text,
  )
  refuse(final.parts.every((part) => part.type !== "tool"))
  refuse(state.posts === (answers.length ? 0 : 1))
  const after = yield* sessions.messages({ sessionID: id })
  refuse(
    JSON.stringify(after.filter((row) => rows.some((old) => old.info.id === row.info.id))) === JSON.stringify(rows),
  )
  refuse(after.length === rows.length + (answers.length ? 0 : 1))
  refuse(
    JSON.stringify(yield* sessions.messages({ sessionID: SessionID.make(saved.child) })) === JSON.stringify(children),
  )
  refuse(JSON.stringify(yield* journal.get({ id: saved.child, revision: saved.revision })) === JSON.stringify(outcome))
  refuse(
    JSON.stringify(yield* Receipts.make(database).get({ sessionID: id, messageID: saved.notice })) ===
      JSON.stringify(receipt),
  )
  refuse((yield* jobs.list()).length === 0)
  const checked = yield* ResultContract.load(sessions, id)
  refuse(checked)
  yield* ResultContract.check(sessions, checked)
  return {
    finalGeneration: true,
    posts: state.posts,
    text,
    refs,
    message: final.info.id,
    unchanged: true,
    replay: false,
  }
})

const selected = Effect.gen(function* () {
  if (operation === "produce") return yield* produce
  if (operation === "continue") return yield* complete
  return yield* inspect
})
const work = InstanceStore.Service.use((store) => store.provide({ directory: path.join(root, "workspace") }, selected))
const exit = await Effect.runPromiseExit(work.pipe(Effect.provide(layer), Effect.scoped))
const primary = Exit.isFailure(exit) ? Cause.pretty(exit.cause).slice(0, 16384) : undefined
const errors: { stage: string; name: string; message: string; stack?: string }[] = []
for (const [stage, finish] of [
  ["runtime", () => RuntimeRegistry.drain()],
  ["files", drainFileLoggers],
  ["log", () => Log.drain()],
  ["profile", closeProcessProfile],
] as const) {
  await finish().catch((err: unknown) =>
    errors.push({
      stage,
      name: err instanceof Error ? err.name.slice(0, 256) : "UnknownFailure",
      message: err instanceof Error ? err.message.slice(0, 2048) : "Non-error retirement failure",
      stack: err instanceof Error ? err.stack?.slice(0, 4096) : undefined,
    }),
  )
}
if (primary || errors.length) {
  await writeFile(
    path.join(root, `${operation}-failure.json`),
    JSON.stringify({
      state,
      primary,
      cleanup: errors,
    }),
    "utf8",
  )
  process.exitCode = 1
}
if (Exit.isSuccess(exit) && !errors.length)
  await writeFile(
    path.join(root, `${operation === "produce" ? "producer" : operation === "continue" ? "continued" : "cold"}.json`),
    JSON.stringify(exit.value),
    "utf8",
  )
