import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, EventV2Bridge.node, Storage.node, Agent.node, Truncate.node]),
  ),
)

it.instance(
  "actual goal reads release verified absent or historical complete state and preserve noncomplete work",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const goals = RayaGoal.make({ storage, sessions })
      const tool = yield* goalTools(goals, sessions).get
      const def = yield* tool.init()
      for (const status of ["absent", "active", "paused", "blocked", "complete"] as const) {
        const session = yield* sessions.create({ metadata: { [RayaChief.phaseKey]: "verify", preserved: status } })
        yield* Effect.addFinalizer(() => goals.clear(session.id))
        if (status !== "absent") {
          const goal = yield* goals.create(session.id, "Retain the original work until its real state is inspected")
          if (status === "paused") yield* goals.control(session.id, "paused")
          if (status === "blocked") yield* goals.update(session.id, { status: "blocked", reason: "Pending evidence" })
          if (status === "complete") {
            // Exercise the shipped strict reader with a real historical record; this does not claim an audited task.
            const state = yield* Schema.decodeUnknownEffect(RayaGoal.State)({ ...goal, status: "complete" })
            yield* storage.replace(["raya", "goal", session.id], state)
          }
        }
        const before = yield* goals.get(session.id)
        const response = yield* def.execute(
          {},
          {
            sessionID: session.id,
            messageID: MessageID.ascending(),
            agent: "auto",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const current = yield* sessions.get(session.id)
        expect(RayaChief.phase(current.metadata)).toBe(status === "absent" || status === "complete" ? "done" : "goal")
        expect(current.metadata?.preserved).toBe(status)
        expect(yield* goals.get(session.id)).toEqual(before)
        expect(response.metadata.status).toBe(status === "absent" ? undefined : status)
        if (status === "absent") expect(response.title).toBe("No goal")
        if (status !== "absent") expect(JSON.parse(response.output).goal.status).toBe(status)
      }
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)
