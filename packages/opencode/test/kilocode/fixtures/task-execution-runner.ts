import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTask } from "@/kilocode/task"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"

const dir = process.argv[2]
const ready = process.argv[3]
const mode = process.argv[4]
if (!dir || !ready || (mode !== "seed" && mode !== "hold" && mode !== "once"))
  throw new Error("Expected storage, receipt, and mode")

const runID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const sessionID = SessionID.make("ses_execution_runner")

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const tasks = RayaTask.make({ storage })
    const agent =
      mode === "seed"
        ? yield* tasks.create({
            name: "Execution owner",
            objective: "Prove one continuing turn",
            schedule: { kind: "manual" },
          })
        : (yield* tasks.list())[0]
    if (!agent) return yield* Effect.die(new Error("Missing execution owner"))
    const session = {
      id: sessionID,
      directory: process.cwd(),
      metadata: {
        rayaRoutine: {
          version: 1,
          agentID: agent.id,
          runID,
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        },
      },
    }
    const sessions = {
      create: () => Effect.die("must not create a session"),
      get: () => Effect.succeed(session),
      messages: () => Effect.succeed([]),
      children: () => Effect.succeed([]),
    } as unknown as Pick<Session.Interface, "create" | "get" | "messages" | "children">
    const goals = RayaGoal.make({ storage, sessions })
    const runner = RayaTaskRunner.make({
      storage,
      sessions,
      continuation: (run) =>
        Effect.promise(() => Bun.write(`${ready}.trace`, "continuation")).pipe(
          Effect.andThen(
            RayaGoalContinuation.resume({
              sessionID: run.sessionID,
              storage,
              sessions,
              run: async (_session, _objective, _directory, _message, _queued, signal) => {
                const goal = await Effect.runPromise(goals.get(sessionID))
                await Bun.write(
                  `${ready}.dispatch`,
                  JSON.stringify({
                    id: goal?.dispatch?.id,
                    messageID: goal?.dispatch?.messageID,
                    phase: goal?.dispatch?.phase,
                  }),
                )
                await Bun.write(ready, "entered")
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
              },
            }),
          ),
          Effect.asVoid,
          Effect.orDie,
        ),
    })
    if (mode === "seed") {
      yield* runner.tasks.record({
        id: runID,
        agentID: agent.id,
        sessionID,
        at: Date.now(),
        status: "running",
        scheduleVersion: 1,
        trigger: { kind: "manual" },
      })
      yield* goals.create(sessionID, "Prove one continuing turn")
      yield* Effect.promise(() => Bun.write(ready, "seeded"))
      return
    }
    const items = yield* runner.tasks.list()
    const history = yield* runner.tasks.runsFor(agent.id)
    const goal = yield* goals.get(sessionID)
    yield* Effect.promise(() =>
      Bun.write(
        `${ready}.state`,
        JSON.stringify({
          items: items.map((item) => item.id),
          runs: history.map((item) => item.status),
          goal: goal?.status,
        }),
      ),
    )
    yield* runner.revive()
    yield* Effect.promise(() => Bun.write(`${ready}.revived`, "revived"))
    if (mode === "once") {
      yield* Effect.sleep("1 second")
      if (!(yield* Effect.promise(() => Bun.file(ready).exists()))) {
        const current = yield* goals.get(sessionID)
        yield* Effect.promise(() =>
          Bun.write(
            ready,
            JSON.stringify({
              state: "no-replay",
              id: current?.dispatch?.id,
              messageID: current?.dispatch?.messageID,
              phase: current?.dispatch?.phase,
            }),
          ),
        )
      }
      return
    }
    while (true) yield* Effect.sleep("1 second")
  }).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    Effect.exit,
  ),
)
if (Exit.isFailure(result)) {
  await Bun.write(ready, "denied")
  process.exit(10)
}
