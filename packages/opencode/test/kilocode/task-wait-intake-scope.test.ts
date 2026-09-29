import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaGoal } from "@/kilocode/goal"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

for (const kind of ["ordinary", "malformed", "routine"] as const)
  it.live(
    `changed-intent reply accounting preserves ${kind} scope`,
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const id = SessionID.make(`ses_scope_${crypto.randomUUID()}`)
        const metadata =
          kind === "ordinary"
            ? undefined
            : {
                rayaRoutine:
                  kind === "malformed"
                    ? { version: 2, agentID: "invalid" }
                    : {
                        version: 2,
                        agentID: "worker",
                        runID: "run",
                        scheduleVersion: 1,
                        trigger: { kind: "manual" },
                      },
              }
        const rows: MessageV2.WithParts[] = []
        const goals = RayaGoal.make({
          storage,
          sessions: {
            messages: () => Effect.succeed(rows),
            children: () => Effect.succeed([]),
            get: () => Effect.succeed({ id, metadata } as Session.Info),
          },
        })
        yield* Effect.addFinalizer(() => goals.clear(id))
        yield* goals.create(id, "Original reply", undefined, undefined, undefined, undefined, undefined, "reply")
        const queued = yield* goals.continued(id)
        expect(queued?.dispatch).toBeDefined()
        const user = queued?.dispatch?.messageID
        if (user === undefined) throw new Error("The actual queued dispatch has no user message identity")
        const assistant = MessageID.ascending()
        const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("scope") }
        rows.push({
          info: { id: user, sessionID: id, role: "user", time: { created: Date.now() }, agent: "code", model },
          parts: [],
        })
        rows.push({
          info: {
            id: assistant,
            parentID: user,
            sessionID: id,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            agent: "code",
            mode: "code",
            path: { cwd: process.cwd(), root: process.cwd() },
            cost: 0.25,
            tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            providerID: model.providerID,
            modelID: model.modelID,
            finish: "stop",
          },
          parts: [
            { id: PartID.ascending(), messageID: assistant, sessionID: id, type: "text", text: "Original response" },
          ],
        })
        const revised = yield* goals.revise(id, "Fresh reply")
        expect(revised.intent).not.toBe(queued?.dispatch?.intent)
        const turn = yield* goals.recordTurn(id, assistant)
        expect(turn?.state.usage.turns).toBe(1)
        expect(turn?.state.usage.cost).toBe(0.25)
        expect(turn?.state.status).toBe(kind === "routine" ? "active" : "complete")
        expect(turn?.state.reply?.body).toBe(kind === "routine" ? undefined : "Original response")
        expect(turn?.retry).toBe(false)
        expect(yield* goals.recordTurn(id, assistant)).toBeUndefined()
      }),
    30_000,
  )
