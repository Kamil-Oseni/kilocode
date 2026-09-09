import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { SessionID, MessageID } from "@/session/schema"
import type { Session } from "@/session/session"
import { RayaGoal } from "@/kilocode/goal"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { selfHealVerify } from "@/kilocode/tool/self-heal-verify"
import { checkout } from "./fixtures/self-heal-worktree"
import { testEffect } from "../lib/effect"
import { tmpdirScoped, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        FSUtil.node,
        CrossSpawnSpawner.node,
        Agent.node,
        Config.node,
        Plugin.node,
        RuntimeFlags.node,
        Truncate.node,
        Git.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

for (const allowed of [true, false])
  it.live(
    `snapshot verification uses actual shell permission and execution: ${allowed}`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const source = yield* Effect.promise(() => checkout(path.join(directory, "storage")))
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const sessionID = SessionID.make("ses_permission")
          const item = yield* RayaSelfHeal.make(storage).create({ description: "Verify shell permission boundary" })
          const outcome = {
            id: crypto.randomUUID(),
            itemID: item.id,
            sessionID,
            source,
            phase: "submitted",
            revision: 0,
            at: Date.now(),
            worktree: {
              root: directory,
              directory: source.root,
              common: path.join(source.root, ".git"),
              branch: "fixture",
              commit: source.commit,
            },
          }
          yield* storage.create(
            ["raya", "self-heal", "repair", createHash("sha256").update(item.id).digest("hex"), "0"],
            { owner: "fixture", outcome },
          )
          yield* storage.create(["fixture-session", sessionID], {
            id: sessionID,
            directory: source.root,
            metadata: {
              rayaSelfHealAttempt: outcome.id,
              rayaSelfHealSource: source,
              rayaSelfHealWorktree: outcome.worktree,
            },
          })
          const goals = RayaGoal.make({
            storage,
            sessions: {
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
              get: (id) => storage.read<Session.Info>(["fixture-session", id]).pipe(Effect.orDie),
            },
          })
          yield* goals.create(sessionID, "Verify a captured source", undefined, undefined, item.id)
          const info = yield* selfHealVerify(goals, storage)
          const tool = yield* info.init()
          const requests: string[] = []
          const messageID = MessageID.ascending()
          const result = yield* tool
            .execute(
              { command: "echo snapshot-check" },
              {
                sessionID,
                messageID,
                callID: "permission-check",
                agent: "code",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: (request) =>
                  Effect.gen(function* () {
                    requests.push(request.permission)
                    if (!allowed) throw new Error("Permission denied by fixture")
                  }),
              },
            )
            .pipe(Effect.exit)
          expect(requests.length).toBeGreaterThan(0)
          expect(Exit.isSuccess(result)).toBe(allowed)
          if (Exit.isSuccess(result)) {
            expect(result.value.output).toContain("snapshot-check")
            expect(result.value.metadata).toMatchObject({ exit: 0 })
            expect(result.value.metadata).toHaveProperty("verification")
          }
          yield* goals.clear(sessionID)
          const inspected = yield* tool.execute(
            { action: "inspect", messageID, callID: "permission-check" },
            {
              sessionID,
              messageID: MessageID.ascending(),
              callID: "inspect-check",
              agent: "code",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.die("Inspection must not request execution permission or replay work"),
            },
          )
          const retained: unknown = JSON.parse(inspected.output)
          expect(retained).toMatchObject({ intent: { callID: "permission-check" } })
          expect(retained).toMatchObject(allowed ? { result: { exit: 0 } } : { terminal: { status: "failed" } })
          if (!allowed) expect(retained).not.toHaveProperty("result")
        }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage"))), provideInstance(source.root))
      }),
    30_000,
  )
