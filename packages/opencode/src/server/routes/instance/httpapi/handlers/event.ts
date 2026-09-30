import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

// kilocode_change start - serialize once when enqueuing to enforce the per-client byte bound
function eventData(data: string): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data,
  }
}
// kilocode_change end

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface) {
  void events
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // kilocode_change start - GlobalBus includes encoded EventV2 events, sync envelopes, and Kilo's legacy
    // Bus events. EventV2.listen would silently drop the latter two groups. Register eagerly to avoid gaps.
    const wake = yield* Queue.dropping<void>(1)
    const limit = { count: 256, bytes: 512 * 1024 }
    const pending: { data: string; type: string }[] = []
    let bytes = 0
    let closed = false
    const signal = () => void Queue.offerUnsafe(wake, undefined)
    const terminal = (type: string, properties: Record<string, string>) => {
      pending.length = 0
      bytes = 0
      pending.push({ data: JSON.stringify({ id: eventID(), type, properties }), type })
      closed = true
      signal()
    }
    const listener = (event: GlobalEvent) => {
      if (event.directory !== instance.directory) return
      if (event.workspace !== undefined && event.workspace !== workspaceID) return
      if (event.payload?.type === "server.instance.disposed") {
        terminal("server.instance.disposed", event.payload.properties ?? {})
        return
      }
      if (closed) return
      const data = (() => {
        try {
          return JSON.stringify(event.payload)
        } catch {
          return undefined
        }
      })()
      if (!data || pending.length >= limit.count || bytes + Buffer.byteLength(data) > limit.bytes) {
        terminal("server.resync_required", { reason: "overflow" })
        return
      }
      pending.push({ data, type: event.payload.type })
      bytes += Buffer.byteLength(data)
      signal()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => void GlobalBus.off("event", listener)),
    )
    const output = Stream.fromQueue(wake).pipe(
      Stream.map(() => {
        const item = pending.shift()
        if (item) bytes -= Buffer.byteLength(item.data)
        if (pending.length) signal()
        return item
      }),
      Stream.filter((item): item is { data: string; type: string } => item !== undefined),
      Stream.takeUntil((item) => item.type === "server.instance.disposed" || item.type === "server.resync_required"),
      Stream.map((item) => item.data),
    )
    // kilocode_change end
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => JSON.stringify({ id: eventID(), type: "server.heartbeat", properties: {} })), // kilocode_change
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      // kilocode_change start - use the same pre-serialized frame format as the bounded queue
      Stream.make(JSON.stringify({ id: eventID(), type: "server.connected", properties: {} })).pipe(
        // kilocode_change end
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
