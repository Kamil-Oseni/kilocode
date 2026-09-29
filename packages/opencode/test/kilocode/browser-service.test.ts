// raya_change - Milestone F browser confirmation service tests
import { randomUUID } from "node:crypto"
import { expect } from "bun:test"
import { Bus } from "@/bus"
import { Browser, HostError, digest } from "@/kilocode/browser/service"
import { Event, type Request } from "@/kilocode/browser/protocol"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Queue } from "effect"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const deps = LayerNode.compile(
  LayerNode.group([
    Bus.node,
    Storage.node,
    Database.node,
    SessionProjector.node,
    EffectFlock.node,
    Global.node,
    Session.node,
  ]),
)
const it = testEffect(Browser.layer("2 seconds").pipe(Layer.provideMerge(deps)))

const fixture = Effect.gen(function* () {
  yield* seedProject
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Browser confirmation" })
  const { db } = yield* Database.Service
  const message = MessageID.ascending()
  const part = PartID.ascending()
  const data: Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> = {
    type: "tool",
    callID: "browser-call",
    tool: "browser_navigate",
    state: { status: "pending", input: {}, raw: "" },
  }
  const info: Omit<SessionV1.Assistant, "id" | "sessionID"> = {
    role: "assistant",
    time: { created: 1 },
    parentID: MessageID.ascending(),
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* db
    .insert(MessageTable)
    .values({
      id: message,
      session_id: session.id,
      data: info,
    })
    .pipe(Effect.orDie)
  yield* db.insert(PartTable).values({ id: part, session_id: session.id, message_id: message, data }).pipe(Effect.orDie)
  const row = yield* db.select().from(PartTable).where(eq(PartTable.id, part)).get().pipe(Effect.orDie)
  return {
    db,
    session,
    message,
    part,
    row,
    origin: { messageID: message, callID: data.callID, tool: data.tool, supported: 1 as const },
  }
})

const navigate = (sessionID: SessionID) => ({
  operation: "navigate" as const,
  sessionID,
  url: "https://example.com",
  authorization: {
    version: 1 as const,
    sessionID,
    action: "browser" as const,
    sensitive: false as const,
    source: "legacy_prompt" as const,
  },
})

it.instance("refuses missing canonical invocation and durable host support before publication", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const browser = yield* Browser.Service
    const missing = yield* browser
      .request(navigate(f.session.id), { messageID: f.message, tool: "browser_navigate", supported: 1 })
      .pipe(Effect.flip)
    expect(missing).toBeInstanceOf(HostError)
    expect(missing.message).toContain("canonical tool identity")
    const unsupported = yield* browser
      .request(navigate(f.session.id), { messageID: f.message, callID: "browser-call", tool: "browser_navigate" })
      .pipe(Effect.flip)
    expect(unsupported).toBeInstanceOf(HostError)
    expect(unsupported.message).toContain("durable host support")
    expect(yield* browser.list()).toEqual([])
  }),
)

it.instance(
  "binds dispatch, confirmation, reply, acknowledgement and canonical history exactly",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const browser = yield* Browser.Service
      const bus = yield* Bus.Service
      const events = yield* Queue.unbounded<Request>()
      const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const fiber = yield* browser.request(navigate(f.session.id), f.origin).pipe(Effect.forkChild)
      const request = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
      if (request.operation !== "navigate") throw new Error("Expected actual navigate request")
      expect(request).toMatchObject({ operation: "navigate", sessionID: f.session.id })
      expect(request.confirmation?.version).toBe(1)
      expect(typeof request.confirmation?.identity).toBe("string")
      expect(typeof request.confirmation?.slot).toBe("number")
      expect(JSON.stringify(request)).not.toContain(f.origin.callID)
      expect(JSON.stringify(request)).not.toContain(f.origin.tool)
      const proof = request.confirmation!
      const retried = yield* browser.request(navigate(f.session.id), f.origin).pipe(Effect.flip)
      expect(retried).toBeInstanceOf(HostError)
      expect(retried.message).toContain("safety admission")
      expect(yield* browser.list()).toHaveLength(1)
      const invocation = randomUUID()
      const first = yield* browser.dispatch({ requestID: request.id, proof, invocation })
      expect(first.granted).toBe(true)
      expect(yield* browser.dispatch({ requestID: request.id, proof, invocation })).toEqual({
        granted: false,
        dispatch: first.dispatch,
      })

      const startedAt = Math.max(Date.now(), first.dispatch.at)
      const result = {
        operation: "navigate" as const,
        url: "https://example.com",
        title: "Example",
        receipt: {
          version: 1 as const,
          requestID: request.id,
          startedAt,
          finishedAt: startedAt + 1,
          effect: "navigate" as const,
          outcome: "confirmed" as const,
        },
      }
      const completion = {
        version: 1 as const,
        identity: proof.identity,
        invocation,
        ack: randomUUID(),
        requestID: request.id,
        operation: "navigate" as const,
        outcome: "confirmed" as const,
        startedAt: result.receipt.startedAt,
        finishedAt: result.receipt.finishedAt,
        resultDigest: digest(result),
      }
      expect(yield* browser.confirm({ requestID: request.id, proof, completion })).toEqual(completion)
      const changed = yield* browser
        .confirmation({ requestID: request.id, proof: { ...proof, digest: "0".repeat(64) } })
        .pipe(Effect.flip)
      expect(changed._tag).toBe("BrowserConfirmation.Conflict")

      yield* browser.reply({ requestID: request.id, result })
      expect(yield* Fiber.join(fiber)).toEqual(result)
      expect(yield* browser.list()).toEqual([])
      const settled = yield* browser.confirmation({ requestID: request.id, proof })
      expect(settled).toMatchObject({ granted: false, pending: false, dispatch: first.dispatch, completion })
      const acknowledgement = yield* browser.acknowledge({ requestID: request.id, proof, ack: completion.ack })
      expect(yield* browser.confirmation({ requestID: request.id, proof })).toMatchObject({ acknowledgement })
      expect(yield* f.db.select().from(PartTable).where(eq(PartTable.id, f.part)).get().pipe(Effect.orDie)).toEqual(
        f.row,
      )
    }),
  { git: true },
)

it.instance("times out without fabricating an outcome or granting a later replay", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const browser = yield* Browser.Service
    const bus = yield* Bus.Service
    const events = yield* Queue.unbounded<Request>()
    const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    const fiber = yield* browser.request(navigate(f.session.id), f.origin).pipe(Effect.forkChild)
    const request = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
    if (request.operation !== "navigate") throw new Error("Expected actual navigate request")
    const err = yield* Fiber.join(fiber).pipe(Effect.flip)
    expect(err).toBeInstanceOf(HostError)
    expect(err.code).toBe("timeout")
    const proof = request.confirmation!
    expect(yield* browser.confirmation({ requestID: request.id, proof })).toEqual({
      version: 1,
      proof,
      granted: false,
      pending: false,
    })
    const replay = yield* browser.dispatch({ requestID: request.id, proof, invocation: randomUUID() }).pipe(Effect.flip)
    expect(replay._tag).toBe("BrowserConfirmation.Conflict")
    expect(yield* browser.list()).toEqual([])
  }),
)

it.instance("conditionally cancels only before a browser dispatch and retains exact acknowledgement", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const browser = yield* Browser.Service
    const bus = yield* Bus.Service
    const events = yield* Queue.unbounded<Request>()
    const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
    yield* Effect.addFinalizer(() => Effect.sync(off))
    const fiber = yield* browser.request(navigate(f.session.id), f.origin).pipe(Effect.forkChild)
    const request = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
    if (request.operation !== "navigate") throw new Error("Expected navigate request")
    const proof = request.confirmation!
    const invocation = randomUUID()
    yield* browser.reject({
      requestID: request.id,
      proof,
      invocation,
      error: { code: "cancelled", message: "Stopped before native dispatch" },
    })
    expect((yield* Fiber.join(fiber).pipe(Effect.flip)).code).toBe("cancelled")
    const status = yield* browser.confirmation({ requestID: request.id, proof })
    expect(status.pending).toBe(false)
    expect(status.dispatch).toBeUndefined()
    expect(status.completion).toMatchObject({ outcome: "cancelled", invocation })
    expect((yield* browser.dispatch({ requestID: request.id, proof, invocation }).pipe(Effect.flip))._tag).toBe(
      "BrowserConfirmation.Conflict",
    )
    const ack = yield* browser.acknowledge({ requestID: request.id, proof, ack: status.completion!.ack })
    expect((yield* browser.confirmation({ requestID: request.id, proof })).acknowledgement).toEqual(ack)
  }),
)

it.instance("keeps a browser request pending when native dispatch beats conditional cancellation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const browser = yield* Browser.Service
    const bus = yield* Bus.Service
    const events = yield* Queue.unbounded<Request>()
    const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
    yield* Effect.addFinalizer(() => Effect.sync(off))
    const fiber = yield* browser.request(navigate(f.session.id), f.origin).pipe(Effect.forkChild)
    const request = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
    if (request.operation !== "navigate") throw new Error("Expected navigate request")
    const proof = request.confirmation!
    const invocation = randomUUID()
    const granted = yield* browser.dispatch({ requestID: request.id, proof, invocation })
    expect(granted.granted).toBe(true)
    const conflict = yield* browser
      .reject({
        requestID: request.id,
        proof,
        invocation,
        error: { code: "cancelled", message: "Stopped before native dispatch" },
      })
      .pipe(Effect.flip)
    expect(conflict._tag).toBe("BrowserConfirmation.Conflict")
    expect((yield* browser.confirmation({ requestID: request.id, proof })).pending).toBe(true)
    yield* browser.reject({ requestID: request.id, error: { code: "disconnected", message: "Unknown native outcome" } })
    expect((yield* Fiber.join(fiber).pipe(Effect.flip)).code).toBe("disconnected")
  }),
)
