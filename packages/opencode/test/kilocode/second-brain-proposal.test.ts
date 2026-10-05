import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Fiber, Layer, Queue, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Command, Event, type Request, type Result } from "@/kilocode/second-brain/protocol"
import { SecondBrain } from "@/kilocode/second-brain/service"
import { SecondBrainTool } from "@/kilocode/tool/second-brain"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const id = "14cf4181-5ae8-42ae-8f09-7f02ca07f1c8"
const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionProjector.node),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(FSUtil.node),
    SecondBrain.layer("100 millis").pipe(Layer.provideMerge(Bus.layer)),
  ),
)

function result(request: Request): Result {
  return {
    action: request.command.action,
    project: request.project,
    proposals:
      request.command.action === "list"
        ? []
        : [
            {
              format: "raya.memory.proposal.v1",
              id,
              project: request.project,
              digest: "a".repeat(64),
              status: "pending",
              capture_enabled: false,
              sources: [
                {
                  path: path.join(request.project, "source.txt"),
                  sha256: "b".repeat(64),
                  kind: "document",
                  event_time: null,
                },
              ],
              changes: [{ path: "Projects/example.md", expected: null, content: "Pending note", before: null }],
              provenance: "Sources remain pending until native user review.",
            },
          ],
  }
}

it.instance("real tool binds retained session, authorizes actual source and returns only pending creation", () =>
  Effect.gen(function* () {
    const inst = yield* InstanceState.context
    const sessions = yield* Session.Service
    const chat = yield* sessions.create()
    const brain = yield* SecondBrain.Service
    const bus = yield* Bus.Service
    const events = yield* Queue.unbounded<Request>()
    const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
    yield* Effect.addFinalizer(() => Effect.sync(off))
    const raw = "Actual project source"
    yield* Effect.promise(() => Bun.write(path.join(inst.directory, "source.txt"), raw))
    const asks: Parameters<Tool.Context["ask"]>[0][] = []
    const ctx: Tool.Context = {
      sessionID: chat.id,
      messageID: MessageID.make("msg_brain_tool"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (row) =>
        Effect.sync(() => {
          asks.push(row)
        }),
    }
    const tool = yield* SecondBrainTool.pipe(Effect.flatMap(Tool.init))
    const command = {
      action: "propose" as const,
      id,
      request: {
        changes: [{ path: "Projects/example.md", expected: null, content: "Pending note" }],
        sources: [
          {
            path: "source.txt",
            sha256: createHash("sha256").update(raw).digest("hex"),
            kind: "document" as const,
            event_time: null,
          },
        ],
      },
    }
    const fiber = yield* tool.execute(command, ctx).pipe(Effect.forkChild)
    const request = yield* Queue.take(events).pipe(
      Effect.raceFirst(
        Fiber.join(fiber).pipe(Effect.andThen(Effect.die(new Error("Tool completed before publishing")))),
      ),
      Effect.timeout("1 second"),
    )
    expect(request.project).toBe(chat.directory)
    expect(request.command.action).toBe("propose")
    if (request.command.action !== "propose") throw new Error("Expected proposal")
    expect(request.command.request.sources[0].path).toBe(path.join(inst.directory, "source.txt"))
    expect(asks.map((row) => row.permission)).toEqual(["read", "second_brain_proposal"])
    yield* brain.reply({ requestID: request.id, result: result(request) })
    const value = yield* Fiber.join(fiber)
    expect(value.metadata.status).toBe("pending")
    expect(value.metadata.applied).toBe(false)
    expect(yield* brain.list()).toEqual([])

    const read = yield* tool.execute({ action: "read", id }, ctx).pipe(Effect.forkChild)
    const requested = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
    const closed = {
      ...result(requested),
      proposals: result(requested).proposals.map((row) => ({ ...row, status: "cancelled" as const })),
    }
    yield* brain.reply({ requestID: requested.id, result: closed })
    const inspected = yield* Fiber.join(read)
    expect(inspected.metadata.status).toBe("inspected")
    expect(JSON.parse(inspected.output).proposals[0].status).toBe("cancelled")
    const list = yield* tool.execute({ action: "list" }, ctx).pipe(Effect.forkChild)
    const listing = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
    yield* brain.reply({ requestID: listing.id, result: { ...closed, action: "list" } })
    const listed = yield* Fiber.join(list)
    expect(listed.metadata.status).toBe("inspected")
    expect(JSON.parse(listed.output).proposals[0].status).toBe("cancelled")

    const stale = {
      ...command,
      request: { ...command.request, sources: [{ ...command.request.sources[0], sha256: "c".repeat(64) }] },
    }
    const failed = yield* tool.execute(stale, ctx).pipe(Effect.exit)
    expect(failed._tag).toBe("Failure")
    expect(yield* brain.list()).toEqual([])
    expect(yield* Queue.size(events)).toBe(0)
    const outside = yield* Effect.promise(() => tmpdir())
    yield* Effect.addFinalizer(() => Effect.promise(() => outside[Symbol.asyncDispose]()))
    const target = path.join(outside.path, "foreign.txt")
    yield* Effect.promise(() => Bun.write(target, raw))
    const foreign = {
      ...command,
      request: { ...command.request, sources: [{ ...command.request.sources[0], path: target }] },
    }
    expect((yield* tool.execute(foreign, ctx).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* Queue.size(events)).toBe(0)

    const rejected = yield* tool.execute(command, ctx).pipe(Effect.forkChild)
    const original = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
    yield* brain.reject({
      requestID: original.id,
      error: { code: "conflict", message: "Original publication outcome is unknown" },
    })
    expect((yield* Fiber.join(rejected).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* brain.list()).toEqual([])
    expect(yield* Queue.size(events)).toBe(0)
    yield* sessions.remove(chat.id)
  }),
)

it.instance("foreign project refuses before publication and mismatched reply does not settle original", () =>
  Effect.gen(function* () {
    const inst = yield* InstanceState.context
    const brain = yield* SecondBrain.Service
    const sessionID = SessionID.make("ses_brain_guard")
    const foreign = yield* brain
      .request({ sessionID, project: path.dirname(inst.directory), command: { action: "list" } })
      .pipe(Effect.flip)
    expect(foreign.code).toBe("invalid_request")
    expect(yield* brain.list()).toEqual([])
    const fiber = yield* brain
      .request({ sessionID, project: inst.directory, command: { action: "read", id } })
      .pipe(Effect.forkChild)
    const pending = yield* brain.list().pipe(Effect.repeat({ until: (rows) => rows.length === 1 }))
    const wrong = yield* brain
      .reply({ requestID: pending[0].id, result: { ...result(pending[0]), project: path.dirname(inst.directory) } })
      .pipe(Effect.flip)
    expect(wrong._tag).toBe("SecondBrain.InvalidReplyError")
    expect(yield* brain.list()).toHaveLength(1)
    const closed = {
      ...result(pending[0]),
      proposals: result(pending[0]).proposals.map((row) => ({ ...row, status: "applied" as const })),
    }
    yield* brain.reply({ requestID: pending[0].id, result: closed })
    expect((yield* Fiber.join(fiber)).proposals[0].status).toBe("applied")
    const row = closed.proposals[0]
    const create = yield* brain
      .request({
        sessionID,
        project: inst.directory,
        command: {
          action: "propose",
          id,
          request: {
            sources: row.sources,
            changes: row.changes.map((item) => ({ path: item.path, expected: item.expected, content: item.content })),
          },
        },
      })
      .pipe(Effect.forkChild)
    const original = yield* brain.list().pipe(Effect.repeat({ until: (rows) => rows.length === 1 }))
    const applied = yield* brain
      .reply({ requestID: original[0].id, result: { ...closed, action: "propose" } })
      .pipe(Effect.flip)
    expect(applied._tag).toBe("SecondBrain.InvalidReplyError")
    expect(yield* brain.list()).toHaveLength(1)
    yield* brain.reject({
      requestID: original[0].id,
      error: { code: "conflict", message: "Creation outcome unconfirmed" },
    })
    expect((yield* Fiber.join(create).pipe(Effect.flip)).code).toBe("conflict")
  }),
)

it.instance("disconnected timeout and cancellation clear original request without replay", () =>
  Effect.gen(function* () {
    const inst = yield* InstanceState.context
    const brain = yield* SecondBrain.Service
    const sessionID = SessionID.make("ses_brain_cancel")
    const fiber = yield* brain
      .request({ sessionID, project: inst.directory, command: { action: "list" } })
      .pipe(Effect.forkChild)
    yield* brain.list().pipe(Effect.repeat({ until: (rows) => rows.length === 1 }))
    yield* brain.cancelSession(sessionID)
    expect((yield* Fiber.join(fiber).pipe(Effect.flip)).code).toBe("cancelled")
    expect(yield* brain.list()).toEqual([])
    const timeout = yield* brain
      .request({ sessionID, project: inst.directory, command: { action: "list" } })
      .pipe(Effect.flip)
    expect(timeout.code).toBe("timeout")
    expect(yield* brain.list()).toEqual([])
  }),
)

test("model schema rejects apply and invented proposal IDs", () => {
  expect(Schema.decodeUnknownExit(Command)({ action: "apply", id, digest: "a".repeat(64) })._tag).toBe("Failure")
  expect(Schema.decodeUnknownExit(Command)({ action: "read", id: "invented" })._tag).toBe("Failure")
})
