import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { Refusal } from "@/kilocode/session/tool-refusal"
import { SessionRetirement } from "@/kilocode/session/retirement"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { goalTools } from "@/kilocode/tool/goal"
import * as Truncate from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@/agent/agent"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Storage.node,
      BackgroundJob.node,
      Truncate.node,
      Agent.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const setup = Effect.fn("ChiefRuntimeVerificationTest.setup")(function* (
  status: "completed" | "running" | "error" | "cancelled" = "completed",
) {
  const sessions = yield* Session.Service
  const storage = yield* Storage.Service
  const goals = RayaGoal.make({ storage, sessions })
  const background = yield* BackgroundJob.Service
  const request = "Inspect the private fixture and report its actual contents"
  const parent = yield* sessions.create({
    metadata: { [RayaChief.phaseKey]: "verify", [RayaChief.requestKey]: request, preserved: true },
  })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: parent.id,
    type: "text",
    text: request,
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID: parent.id,
    role: "assistant",
    mode: "auto",
    agent: "auto",
    cost: 0,
    path: { cwd: parent.directory, root: parent.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: model.providerID,
    modelID: model.modelID,
    time: { created: Date.now() },
  })
  const child = yield* sessions.create({ parentID: parent.id, agent: "general" })
  const input = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: child.id,
    role: "user",
    agent: "general",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.id,
    sessionID: child.id,
    type: "text",
    text: "Read the actual fixture",
  })
  const callID = "fixture-runtime-task"
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: parent.id,
    type: "tool",
    tool: "task",
    callID,
    state: {
      status: "running",
      input: {},
      time: { start: Date.now() },
      metadata: { parentSessionId: parent.id, sessionId: child.id, childMessageID: input.id },
    },
  })
  const final = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    parentID: input.id,
    sessionID: child.id,
    role: "assistant",
    mode: "general",
    agent: "general",
    cost: 0,
    path: { cwd: child.directory, root: child.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: model.providerID,
    modelID: model.modelID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: final.id,
    sessionID: child.id,
    type: "text",
    text: "Actual fixture result",
  })
  yield* background.start({
    id: child.id,
    type: "task",
    origin: {
      sessionID: parent.id,
      messageID: assistant.id,
      callID,
      childSessionID: child.id,
      childMessageID: input.id,
    },
    run:
      status === "completed"
        ? Effect.succeed("Actual fixture result")
        : status === "error"
          ? Effect.fail(new Error("Actual fixture failure"))
          : Effect.never,
  })
  if (status === "cancelled") yield* background.cancel(child.id)
  if (status !== "running") yield* background.wait({ id: child.id })
  yield* Effect.addFinalizer(() => background.cancel(child.id).pipe(Effect.asVoid))
  yield* Effect.addFinalizer(() => goals.clear(parent.id))
  return { sessions, storage, goals, background, parent, user, assistant, child, input, final, callID, part, request }
})

const verify = (state: Effect.Success<ReturnType<typeof setup>>, opts: { callID?: string; inputID?: MessageID } = {}) =>
  ChiefVerification.foreground({
    storage: state.storage,
    sessions: state.sessions,
    background: state.background,
    sessionID: state.parent.id,
    messageID: state.assistant.id,
    callID: opts.callID ?? state.callID,
    childID: state.child.id,
    inputID: opts.inputID ?? state.input.id,
    request: state.request,
  })

it.instance(
  "authenticated running recovery refuses normally and retains its worker until actual completion",
  () =>
    Effect.gen(function* () {
      for (const mode of ["owned", "foreign", "background"] as const) {
        const state = yield* setup()
        yield* state.goals.create(state.parent.id, state.request)
        yield* verify(state)
        const before = yield* state.sessions.get(state.parent.id)
        const input = yield* state.sessions.updateMessage({ ...state.input, id: MessageID.ascending() })
        const call = `continued-${PartID.ascending()}`
        yield* state.sessions.updatePart({
          ...state.part,
          id: PartID.ascending(),
          callID: call,
          state: {
            status: "running",
            input: { task_id: state.child.id },
            time: { start: Date.now() },
            metadata: { sessionId: state.child.id, childMessageID: input.id },
          },
        })
        const done = yield* Deferred.make<string>()
        yield* state.background.start({
          id: state.child.id,
          type: "task",
          metadata: { background: mode === "background" },
          origin: {
            sessionID: state.parent.id,
            messageID: state.assistant.id,
            callID: mode === "foreign" ? "foreign-call" : call,
            childSessionID: state.child.id,
            childMessageID: input.id,
          },
          run: Deferred.await(done),
        })
        const query = {
          storage: state.storage,
          sessions: state.sessions,
          background: state.background,
          sessionID: state.parent.id,
          messageID: state.assistant.id,
          agent: "auto",
          planned: false,
        }
        const owner = SessionRetirement.make()
        const receipt = `${call}-goal`
        const busy = yield* Effect.exit(owner.tool(state.parent.id, receipt, ChiefVerification.retained(query)))
        expect(Exit.isFailure(busy)).toBe(true)
        if (!Exit.isFailure(busy)) throw new Error("Running recovery was accepted")
        const error = Cause.squash(busy.cause)
        expect(error instanceof Refusal).toBe(mode === "owned")
        if (error instanceof Refusal) {
          expect(error.reason).toBe("task-recovery")
          expect(error.message).toContain("still running")
          expect(Exit.isFailure(yield* Effect.exit(owner.drain))).toBe(true)
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: state.assistant.id,
            sessionID: state.parent.id,
            type: "tool",
            tool: "get_goal",
            callID: receipt,
            state: {
              status: "error",
              input: {},
              error: error.message,
              time: { start: Date.now(), end: Date.now() },
            },
          })
          expect(owner.completed(state.parent.id, receipt, error)).toBe(true)
          expect(Exit.isSuccess(yield* Effect.exit(owner.drain))).toBe(true)
        }
        expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(before.metadata)
        expect((yield* state.background.get(state.child.id))?.status).toBe("running")
        expect(yield* state.sessions.children(state.parent.id)).toHaveLength(1)
        const final = yield* state.sessions.updateMessage({
          ...state.final,
          id: MessageID.ascending(),
          parentID: input.id,
          time: { created: Date.now(), completed: Date.now() },
        })
        yield* Deferred.succeed(done, "Actual continued fixture result")
        yield* state.background.wait({ id: state.child.id })
        if (mode !== "owned") continue
        yield* state.sessions.setMetadata({
          sessionID: state.parent.id,
          metadata: { ...before.metadata, [RayaChief.phaseKey]: "verify" },
        })
        yield* verify({ ...state, input, final, callID: call })
        expect(yield* ChiefVerification.retained(query)).toEqual({
          taskID: state.child.id,
          correction: false,
          inspected: false,
        })
      }
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)

it.instance(
  "runtime verification reads actual goal state after exact completed foreground work",
  () =>
    Effect.gen(function* () {
      for (const status of ["absent", "active", "paused", "blocked", "complete"] as const) {
        const state = yield* setup()
        if (status !== "absent") {
          const goal = yield* state.goals.create(state.parent.id, "Preserve this actual goal during verification")
          if (status === "paused") yield* state.goals.control(state.parent.id, "paused")
          if (status === "blocked")
            yield* state.goals.update(state.parent.id, { status: "blocked", reason: "Actual pending evidence" })
          if (status === "complete") {
            // A shipped typed historical record exercises the strict reader; this fixture does not invent audited work.
            const record = yield* Schema.decodeUnknownEffect(RayaGoal.State)({ ...goal, status: "complete" })
            yield* state.storage.replace(["raya", "goal", state.parent.id], record)
          }
        }
        const before = yield* state.goals.get(state.parent.id)
        yield* verify(state)
        const current = yield* state.sessions.get(state.parent.id)
        expect(RayaChief.phase(current.metadata)).toBe(status === "absent" || status === "complete" ? "done" : "goal")
        expect(current.metadata?.preserved).toBe(true)
        expect(yield* state.goals.get(state.parent.id)).toEqual(before)
        expect(current.metadata?.["raya.chief.verification"]).toMatchObject({
          version: 1,
          kind: "foreground",
          userID: state.user.id,
          messageID: state.assistant.id,
          callID: state.callID,
          child: {
            sessionID: state.child.id,
            inputID: state.input.id,
            messageID: state.final.id,
            completedAt: state.final.time.completed,
          },
          goal: { status },
        })
        expect(
          (yield* state.sessions.messages({ sessionID: state.parent.id }))
            .flatMap((row) => row.parts)
            .filter((part) => part.type === "tool" && part.tool === "get_goal"),
        ).toHaveLength(0)
      }
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)

it.instance(
  "unfinished, failed and cancelled background work cannot release runtime verification",
  () =>
    Effect.gen(function* () {
      for (const status of ["running", "error", "cancelled"] as const) {
        const state = yield* setup(status)
        const before = yield* state.sessions.get(state.parent.id)
        const result = yield* Effect.exit(verify(state))
        expect(Exit.isFailure(result)).toBe(true)
        expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(before.metadata)
        expect(yield* state.goals.get(state.parent.id)).toBeUndefined()
        expect((yield* state.background.get(state.child.id))?.status).toBe(status)
      }
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)

it.instance(
  "wrong invocation, stale child input, new user and strict goal read failure retain verify",
  () =>
    Effect.gen(function* () {
      for (const mode of ["call", "input", "agent", "new-user", "request", "incomplete", "read"] as const) {
        const state = yield* setup()
        if (mode === "agent") yield* state.sessions.updateMessage({ ...state.assistant, agent: "general" })
        if (mode === "new-user") {
          const next = yield* state.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: state.parent.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: next.id,
            sessionID: state.parent.id,
            type: "text",
            text: "A genuinely different request",
          })
        }
        if (mode === "request")
          yield* state.sessions.setMetadata({
            sessionID: state.parent.id,
            metadata: {
              ...(yield* state.sessions.get(state.parent.id)).metadata,
              [RayaChief.requestKey]: "Changed request",
            },
          })
        if (mode === "incomplete")
          yield* state.sessions.updateMessage({ ...state.final, time: { created: state.final.time.created } })
        if (mode === "read") yield* state.storage.replace(["raya", "goal", state.parent.id], { unsupported: true })
        const before = yield* state.sessions.get(state.parent.id)
        const result = yield* Effect.exit(
          verify(state, {
            callID: mode === "call" ? "different-invocation" : undefined,
            inputID: mode === "input" ? MessageID.ascending() : undefined,
          }),
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(before.metadata)
        if (mode === "read") {
          expect(yield* state.storage.read(["raya", "goal", state.parent.id])).toEqual({ unsupported: true })
          yield* state.storage.remove(["raya", "goal", state.parent.id])
        }
      }
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)

it.instance(
  "same-user Task reservations coexist without admitting stale invocation lineage",
  () =>
    Effect.gen(function* () {
      const state = yield* setup()
      const rows = yield* state.sessions.messages({ sessionID: state.parent.id })
      const user = rows.find((row) => row.info.role === "user")!
      yield* state.sessions.setMetadata({
        sessionID: state.parent.id,
        metadata: {
          ...(yield* state.sessions.get(state.parent.id)).metadata,
          [RayaChief.phaseKey]: "goal",
        },
      })
      const first = rows.find((row) => row.info.id === state.assistant.id)!.parts.find((part) => part.type === "tool")!
      if (first.type !== "tool") throw new Error("Expected tool")
      yield* state.sessions.updatePart({ ...first, id: PartID.ascending(), callID: "parallel-invocation" })
      const reserve = (callID: string) =>
        ChiefVerification.reserve({
          sessions: state.sessions,
          sessionID: state.parent.id,
          messageID: state.assistant.id,
          userID: user.info.id,
          callID,
          request: state.request,
        })
      yield* Effect.all([reserve(state.callID), reserve("parallel-invocation")], { concurrency: "unbounded" })
      expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe("verify")
      const before = (yield* state.sessions.get(state.parent.id)).metadata
      expect(Exit.isFailure(yield* Effect.exit(reserve("foreign-invocation")))).toBe(true)
      expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(before)
      yield* reserve(state.callID)
      expect((yield* verify(state)).callID).toBe(state.callID)
      const published = (yield* state.sessions.get(state.parent.id)).metadata
      const later = yield* Effect.exit(verify(state, { callID: "parallel-invocation" }))
      expect(Exit.isFailure(later)).toBe(true)
      if (Exit.isFailure(later)) expect(String(later.cause)).toContain("Chief verification generation changed")
      expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(published)
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)

for (const active of [false, true])
  it.instance(
    `${active ? "Active" : "Absent"} goal observation cannot retire an overlapping original Task reservation`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup()
        if (active) yield* state.goals.create(state.parent.id, state.request)
        yield* state.sessions.setMetadata({
          sessionID: state.parent.id,
          metadata: { ...state.parent.metadata, [RayaChief.phaseKey]: "task" },
        })
        const def = yield* (yield* goalTools(state.goals, state.sessions).get).init()
        const ctx = {
          sessionID: state.parent.id,
          messageID: state.assistant.id,
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const reserve = ChiefVerification.reserve({
          sessions: state.sessions,
          storage: state.storage,
          sessionID: state.parent.id,
          messageID: state.assistant.id,
          callID: state.callID,
          userID: state.user.id,
          request: state.request,
        })
        expect((yield* def.execute({}, ctx)).title).toBe(active ? "Current goal" : "No goal")
        expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe("task")
        yield* Effect.all([reserve, def.execute({}, ctx)], { concurrency: "unbounded" })
        expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe("verify")
        yield* def.execute({}, ctx)
        expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe("verify")
        const before = (yield* state.sessions.get(state.parent.id)).metadata
        const refused = yield* Effect.exit(
          ChiefVerification.reserve({
            sessions: state.sessions,
            sessionID: state.parent.id,
            messageID: state.assistant.id,
            callID: state.callID,
            userID: state.user.id,
            request: "A replacement request",
          }),
        )
        expect(Exit.isFailure(refused)).toBe(true)
        expect((yield* state.sessions.get(state.parent.id)).metadata).toEqual(before)
        yield* verify(state)
        expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe(active ? "goal" : "done")
        yield* def.execute({}, ctx)
        expect(RayaChief.phase((yield* state.sessions.get(state.parent.id)).metadata)).toBe(active ? "goal" : "done")
      }),
    { config: { formatter: false, lsp: false, enabled_providers: [] } },
  )
