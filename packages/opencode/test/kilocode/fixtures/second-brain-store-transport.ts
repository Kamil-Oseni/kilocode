/** Actual scoped Tool/Service; fixture HTTP adapter delegates unchanged service gates. */
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { SecondBrain } from "@/kilocode/second-brain/service"
import { Event, RequestID, type Result, type Failure } from "@/kilocode/second-brain/protocol"
import { SecondBrainTool } from "@/kilocode/tool/second-brain"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstanceEffect, testInstanceStoreLayer, seedProject } from "../../fixture/fixture"

const directory = process.argv[2]
if (!directory || !path.isAbsolute(directory)) throw new Error("Private project required")
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionProjector.node),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(Database.node),
    SecondBrain.layer("15 seconds").pipe(Layer.provideMerge(Bus.layer)),
    testInstanceStoreLayer,
  ),
)
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* seedProject
      const inst = yield* InstanceState.context
      const sessions = yield* Session.Service
      const brain = yield* SecondBrain.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create()
      yield* Effect.addFinalizer(() => sessions.remove(chat.id).pipe(Effect.orDie))
      const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
      const off = yield* bus.subscribeCallback(Event.Requested, (event) => {
        for (const stream of streams)
          stream.enqueue(new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"))
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const local = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, inst)))
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/fixture/end-events" && request.method === "POST") {
            for (const stream of streams) stream.close()
            streams.clear()
            return Response.json(true)
          }
          if (url.pathname === "/event")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  streams.add(controller)
                  controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
                },
                cancel() {
                  /* The fixture closes all retained stream controllers below. */
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            )
          if (request.method === "GET") return Response.json(await local(brain.list()))
          const body: { result: Result; error: Failure } = await request.json()
          const requestID = url.pathname.split("/").at(-2)
          if (!requestID) return new Response(null, { status: 400 })
          const exit = await local(
            url.pathname.endsWith("/reply")
              ? brain.reply({ requestID: RequestID.make(requestID), result: body.result }).pipe(Effect.exit)
              : brain.reject({ requestID: RequestID.make(requestID), error: body.error }).pipe(Effect.exit),
          )
          return Response.json(exit._tag === "Success", { status: exit._tag === "Success" ? 200 : 400 })
        },
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const faults: unknown[] = []
          for (const stream of streams) {
            try {
              stream.close()
            } catch (error) {
              faults.push(error)
            }
          }
          if (faults.length) throw new AggregateError(faults, "Original fixture stream closure failed")
        }).pipe(Effect.ensuring(Effect.promise(() => server.stop()))),
      )
      console.log("RAYA_FIXTURE " + JSON.stringify({ origin: server.url.toString() }))
      const tool = yield* SecondBrainTool.pipe(Effect.flatMap(Tool.init))
      const asks: string[] = []
      const ctx: Tool.Context = {
        sessionID: chat.id,
        messageID: MessageID.make("msg_store_transport"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (input) =>
          Effect.sync(() => {
            asks.push(input.permission)
          }),
      }
      const input = Bun.stdin.stream().getReader()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => input.cancel()).pipe(Effect.ensuring(Effect.sync(() => input.releaseLock()))),
      )
      while (true) {
        yield* Effect.promise(() => Bun.write(path.join(directory, "transport-phase.fixture"), "awaiting input"))
        const chunk = yield* Effect.promise(() => input.read())
        if (chunk.done) break
        const command: { action: string; id: string } = JSON.parse(new TextDecoder().decode(chunk.value))
        if (command.action === "stop") {
          const eof = yield* Effect.promise(() => input.read())
          if (!eof.done) throw new Error("Original STOP must be followed by input EOF")
          break
        }
        const source = "Disposable source revision"
        const result = yield* tool.execute(
          {
            action: "propose",
            id: command.id,
            request: {
              changes: [{ path: "Projects/review.md", expected: null, content: "Reviewed pending correction" }],
              sources: [
                {
                  path: "source.txt",
                  sha256: createHash("sha256").update(source).digest("hex"),
                  kind: "document",
                  event_time: null,
                },
              ],
            },
          },
          ctx,
        )
        console.log(
          "RAYA_FIXTURE " + JSON.stringify({ result: JSON.parse(result.output), metadata: result.metadata, asks }),
        )
      }
    }).pipe(provideInstanceEffect(directory), Effect.scoped),
  )
} finally {
  await Bun.write(path.join(directory, "transport-phase.fixture"), "disposing scoped runtime")
  await runtime.dispose()
}
await Bun.write(path.join(directory, "transport-phase.fixture"), "joined scoped runtime")
// Finite fixture foreground exit only after original input EOF, server/streams and scoped runtime joined.
// This does not assert native-family retirement or global runtime lifecycle acceptance.
process.exit(0)
