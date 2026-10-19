import { afterAll, expect } from "bun:test"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { read } from "@/kilocode/goal/read-artifact"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { final } from "@/kilocode/task/final-report"
import { verify } from "@/kilocode/task/final-output"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { remove as cleanup } from "./cleanup"

const db = path.join(os.tmpdir(), `raya-final-output-${process.pid}-${crypto.randomUUID()}.sqlite`)
afterAll(async () => {
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(cleanup))
}, 30_000)
const root = LayerNode.group([
  Bus.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
  FSUtil.node,
])
const env = AppNodeBuilder.build(root, [
  [Database.node, Database.layerFromPath(db)],
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))
const text = "\ufeffLiteral é\r\nTrailing space preserved. \n"
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// The audit is seeded, never treated as output verification. Session messages,
// Goal dispatch, bound-object Read metadata and persisted run identity are real.
const seed = Effect.fn("FinalOutputTest.seed")(function* (
  answer = text,
  source = text,
  earlier = false,
  missing = false,
) {
  const dir = yield* tmpdirScoped()
  const fs = yield* FSUtil.Service
  const file = path.join(dir, "approved.txt")
  yield* fs.writeFileString(file, source)
  const canonical = yield* fs.realPath(file)
  const contract = {
    kind: "file" as const,
    path: canonical,
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
  }
  const storage = yield* Storage.Service
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const goals = RayaGoal.make({ storage, sessions })
  const runner = RayaTaskRunner.make({ storage, database, sessions })
  const agent = yield* runner.tasks.create({
    name: "Delivery fixture",
    objective: "Return the approved file",
    schedule: { kind: "manual" },
    access: "brief",
    memoryScope: "session",
  })
  const id = crypto.randomUUID()
  const chat = yield* sessions.create({
    metadata: {
      rayaRoutine: {
        version: 2,
        agentID: agent.id,
        runID: id,
        scheduleVersion: agent.scheduleVersion ?? 1,
        trigger: { kind: "manual" },
      },
    },
  })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const created = yield* goals.create(
    chat.id,
    agent.objective,
    user.id,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { agentID: agent.id, runID: id, sessionID: chat.id },
  )
  const active = yield* goals.initial(chat.id, created.intent!, "delivery-fixture")
  if (!active?.dispatch) throw new Error("Original Goal dispatch required")
  const reading = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ref.modelID,
    providerID: ref.providerID,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
    finish: "tool-calls",
  })
  const bound = yield* KiloReadObject.file(file)
  const result = yield* KiloReadObject.use(bound, (file) =>
    read(
      fs,
      file,
      Effect.gen(function* () {
        const bytes = yield* Effect.tryPromise(() => file.read())
        const value = bytes
          .toString("utf8")
          .replace(/\r\n|\r/g, "\n")
          .replace(/\n$/, "")
        const count = bytes.length === 0 ? 0 : value.split("\n").length
        return {
          output: bytes.toString("utf8"),
          metadata: {
            display: { type: "file", text: value, lineStart: 1, lineEnd: count, totalLines: count, truncated: false },
          },
        }
      }),
    ),
  )
  const action = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: reading.id,
    type: "tool",
    callID: "original-read",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: file },
      output: result.output,
      title: "Original source",
      metadata: result.metadata,
      time: { start: reading.time.created, end: Date.now() },
    },
  })
  yield* sessions.updateMessage({ ...reading, time: { ...reading.time, completed: Date.now() } })
  const parent = earlier
    ? yield* Effect.gen(function* () {
        if (!(yield* goals.finished(chat.id, reading.id))) throw new Error("Original read turn did not finish")
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* goals.follow(chat.id, created.intent!, user.id, "delivery-fixture")
        return user
      })
    : user
  const at = Date.now()
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: parent.id,
    agent: "build",
    mode: "build",
    modelID: ref.modelID,
    providerID: ref.providerID,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at, completed: at },
    finish: "stop",
  })
  if (!missing)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: message.id,
      type: "text",
      text: answer,
    })
  const finished = yield* goals.finished(chat.id, message.id)
  if (!finished?.dispatch) throw new Error("Original finished dispatch required")
  const goal = {
    ...finished,
    status: "complete" as const,
    activeAt: undefined,
    audit: { summary: "Work audit precedes final verification", verifiedAt: at, requirements: [] },
  }
  yield* storage.replace(["raya", "goal", chat.id], goal)
  const turns = earlier
    ? [
        {
          turnID: user.id,
          messages: [{ messageID: reading.id, actions: [{ actionID: action.id, status: "completed" as const }] }],
        },
        { turnID: parent.id, messages: [{ messageID: message.id, actions: [] }] },
      ]
    : [
        {
          turnID: user.id,
          messages: [
            { messageID: reading.id, actions: [{ actionID: action.id, status: "completed" as const }] },
            { messageID: message.id, actions: [] },
          ],
        },
      ]
  const run = yield* runner.tasks.record({
    id,
    agentID: agent.id,
    sessionID: chat.id,
    at: created.createdAt,
    status: "running",
    goalCreatedAt: created.createdAt,
    scheduleVersion: agent.scheduleVersion ?? 1,
    trigger: { kind: "manual" },
    trace: { version: 1, goalCreatedAt: created.createdAt, turns },
  })
  const rows = yield* sessions.messages({ sessionID: chat.id })
  const candidate = final(run, goal, rows, true, missing)
  if (!candidate) throw new Error("Actual original final selection required")
  return { fs, file, contract, sessions, goal, run, rows, candidate, action, reading, user }
})

for (const source of ["", text])
  it.instance(
    `retains a genuine missing final textpart as unavailable with ${Buffer.byteLength(source)} approved bytes`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* seed("", source, false, true)
        const before = yield* ctx.sessions.messages({ sessionID: ctx.run.sessionID })
        expect(final(ctx.run, ctx.goal, ctx.rows)).toBeUndefined()
        expect(final(ctx.run, ctx.goal, ctx.rows, true)).toBeUndefined()
        expect(ctx.candidate.summary).toBe("")
        expect(ctx.candidate.report.partIDs).toEqual([])
        const result = yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)
        expect(result.status).toBe("unavailable")
        expect(result.reason).toBe("final-missing")
        expect(result.final).toEqual({
          messageID: ctx.candidate.report.messageID,
          sha256: createHash("sha256").update("").digest("hex"),
          bytes: 0,
        })
        expect(yield* ctx.sessions.messages({ sessionID: ctx.run.sessionID })).toEqual(before)
      }),
  )

it.instance("verifies exact original UTF-8 final bytes using the actual full Read receipt", () =>
  Effect.gen(function* () {
    const ctx = yield* seed()
    const result = yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)
    expect(result.status).toBe("passed")
    expect(result.contract).toEqual(ctx.contract)
    expect(result.source).toMatchObject({
      messageID: ctx.reading.id,
      partID: ctx.action.id,
      callID: "original-read",
      path: ctx.file,
      canonical: ctx.contract.path,
      bytes: ctx.contract.bytes,
      sha256: ctx.contract.sha256,
    })
    expect(result.final).toEqual({
      messageID: ctx.candidate.report.messageID,
      bytes: ctx.contract.bytes,
      sha256: ctx.contract.sha256,
    })
  }),
)

it.instance("accepts an earlier genuine traced Read turn after an actual same-Goal follow dispatch", () =>
  Effect.gen(function* () {
    const ctx = yield* seed(text, text, true)
    expect(ctx.goal.dispatch?.messageID).not.toBe(ctx.user.id)
    expect((yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)).status).toBe("passed")
  }),
)

for (const source of ["", " \r\n\t", "\ufeff", "\ufffd"])
  it.instance(`supports explicit completed text with ${JSON.stringify(source)} bytes`, () =>
    Effect.gen(function* () {
      const ctx = yield* seed(source, source)
      expect((yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)).status).toBe("passed")
      if (!source.trim()) expect(final(ctx.run, ctx.goal, ctx.rows)).toBeUndefined()
    }),
  )

it.instance("rejects an ill-formed original final string instead of replacing its surrogate bytes", () =>
  Effect.gen(function* () {
    const ctx = yield* seed("\ud800", "\ufffd")
    const result = yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)
    expect(result.status).toBe("unavailable")
    expect(result.reason).toBe("final-encoding")
  }),
)

for (const [name, answer] of [
  ["prefix", `1: ${text}`],
  ["prose", `The file contains: ${text}`],
  ["suffix", `${text}Completed.`],
  ["newline normalization", text.replaceAll("\r\n", "\n")],
  ["Unicode normalization", text.normalize("NFD")],
  ["trim", text.trim()],
])
  it.instance(`retains an original ${name} mismatch without normalizing it`, () =>
    Effect.gen(function* () {
      const ctx = yield* seed(answer)
      const before = yield* ctx.sessions.messages({ sessionID: ctx.run.sessionID })
      const result = yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)
      expect(result.status).toBe("mismatch")
      expect(result.final.sha256).toBe(createHash("sha256").update(answer).digest("hex"))
      expect(ctx.candidate.summary).toBe(answer)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.run.sessionID })).toEqual(before)
    }),
  )

it.instance("refuses changed source, borrowed candidate and untraced Read authority", () =>
  Effect.gen(function* () {
    const ctx = yield* seed()
    expect(
      (yield* verify(ctx.contract, { ...ctx.run, trace: undefined }, ctx.goal, ctx.rows, ctx.candidate)).status,
    ).toBe("unavailable")
    expect(
      (yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, { ...ctx.candidate, summary: "borrowed" })).status,
    ).toBe("unavailable")
    const rows = ctx.rows.map((row) =>
      row.info.id === ctx.reading.id ? { ...row, info: { ...row.info, parentID: MessageID.ascending() } } : row,
    )
    expect((yield* verify(ctx.contract, ctx.run, ctx.goal, rows, ctx.candidate)).status).toBe("unavailable")
    yield* ctx.fs.writeFileString(ctx.file, "changed source")
    expect((yield* verify(ctx.contract, ctx.run, ctx.goal, ctx.rows, ctx.candidate)).status).toBe("unavailable")
  }),
)

it.instance("refuses a malformed full receipt, missing traced action and foreign or unfinished source message", () =>
  Effect.gen(function* () {
    const ctx = yield* seed()
    if (ctx.action.type !== "tool" || ctx.action.state.status !== "completed")
      throw new Error("Actual completed Read required")
    const action = ctx.action
    const metadata = action.state.metadata
    for (const content of [
      undefined,
      { complete: true },
      { ...(metadata.rayaReadContent as object), complete: false },
    ]) {
      yield* ctx.sessions.updatePart({
        ...action,
        state: { ...action.state, metadata: { ...metadata, rayaReadContent: content } },
      })
      const rows = yield* ctx.sessions.messages({ sessionID: ctx.run.sessionID })
      expect((yield* verify(ctx.contract, ctx.run, ctx.goal, rows, ctx.candidate)).status).toBe("unavailable")
    }
    yield* ctx.sessions.updatePart(action)
    const trace = {
      ...ctx.run.trace!,
      turns: ctx.run.trace!.turns.map((turn) => ({
        ...turn,
        messages: turn.messages.map((message) => ({ ...message, actions: [] })),
      })),
    }
    expect((yield* verify(ctx.contract, { ...ctx.run, trace }, ctx.goal, ctx.rows, ctx.candidate)).status).toBe(
      "unavailable",
    )
    for (const row of ctx.rows.filter((row) => row.info.id === ctx.reading.id)) {
      if (row.info.role !== "assistant") throw new Error("Actual original Read assistant required")
      const unfinished = ctx.rows.map((value) =>
        value === row ? { ...row, info: { ...row.info, time: { created: row.info.time.created } } } : value,
      )
      expect((yield* verify(ctx.contract, ctx.run, ctx.goal, unfinished, ctx.candidate)).status).toBe("unavailable")
      const foreign = ctx.rows.map((value) =>
        value === row
          ? { ...row, parts: row.parts.map((part) => ({ ...part, messageID: MessageID.ascending() })) }
          : value,
      )
      expect((yield* verify(ctx.contract, ctx.run, ctx.goal, foreign, ctx.candidate)).status).toBe("unavailable")
    }
  }),
)
