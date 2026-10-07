import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Git } from "@/git"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Storage.node, CrossSpawnSpawner.node, FSUtil.node, Git.node]),
  ),
)

it.live("cold Routine restore retains a persisted abort without replay or execution acquisition", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const goals = RayaGoal.make({ storage, sessions })
      for (const kind of ["aborted", "unfinished", "newer", "busy", "foreign"] as const) {
        const session = yield* sessions.create({
          metadata: {
            rayaRoutine: {
              version: 2,
              agentID: crypto.randomUUID(),
              runID: crypto.randomUUID(),
              scheduleVersion: 1,
              trigger: { kind: "manual" },
            },
          },
        })
        yield* Effect.addFinalizer(() => goals.clear(session.id))
        yield* goals.create(session.id, "Retain uncertain work")
        const queued = yield* goals.continued(session.id)
        expect(queued?.dispatch).toBeDefined()
        const dispatch = queued!.dispatch!
        yield* goals.dispatched(session.id, dispatch.id)
        yield* sessions.updateMessage({
          id: dispatch.messageID!,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "code",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        })
        const id = MessageID.ascending()
        yield* sessions.updateMessage({
          id,
          parentID: dispatch.messageID!,
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now(), completed: kind === "unfinished" ? undefined : Date.now() },
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          agent: "code",
          mode: "code",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("test-model"),
        })
        if (kind === "newer") {
          const rows = yield* sessions.messages({ sessionID: session.id })
          const latest = rows.at(-1)!.info
          if (latest.role !== "assistant") throw new Error("Missing real assistant")
          yield* sessions.updateMessage({ ...latest, id: MessageID.ascending(), error: undefined })
        }
        const before = yield* goals.get(session.id)
        const restore = () =>
          RayaGoalContinuation.restore({
            directory: kind === "foreign" ? session.directory + "/other" : session.directory,
            storage,
            sessions,
            enabled: () => Effect.succeed(true),
            idle: () => Effect.succeed(kind !== "busy"),
            run: async () => {
              throw new Error("Unexpected replay")
            },
            loop: async () => {
              throw new Error("Unexpected replay")
            },
          })
        yield* restore()
        const after = yield* goals.get(session.id)
        if (kind === "aborted") {
          expect(after?.dispatch?.id).toBe(dispatch.id)
          expect(after?.dispatch?.phase).toBe("finished")
          expect(after?.dispatch?.outcome).toBe("interrupted")
          expect(after?.dispatch?.assistantID).toBe(id)
          expect(after?.status).toBe("active")
          expect(after?.usage).toEqual(before?.usage)
        }
        if (kind !== "aborted") expect(after).toEqual(before)
        yield* restore()
        expect(yield* goals.get(session.id)).toEqual(after)
      }
    }),
  ),
)
