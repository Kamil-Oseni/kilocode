import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/** Populate typed terminal history with real services and the public Stop handler. */
export async function seed(dir: string, witness: string) {
  const { Effect } = await import("effect")
  const { AppRuntime } = await import("../../../src/effect/app-runtime")
  const { InstanceStore } = await import("../../../src/project/instance-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Storage } = await import("../../../src/storage/storage")
  const { Session } = await import("../../../src/session/session")
  const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
  const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
  const { RayaGoal } = await import("../../../src/kilocode/goal")
  const { Server } = await import("../../../src/server/server")
  const { Global } = await import("@opencode-ai/core/global")
  const cycle = async () => {
    const value = JSON.parse(
      await readFile(path.join(Global.Path.data, "storage/raya/voice/usage-reconciliation/v1.json"), "utf8"),
    )
    assert.equal(value.status, "complete")
    assert.equal(value.scanned, 0)
    assert.equal(value.receipts, 0)
    return { cycle: value.cycle, status: value.status, scanned: value.scanned, receipts: value.receipts }
  }
  const before = process.env.RAYA_TEST_EVIDENCE ? await cycle() : undefined
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-kilo-directory": dir }
  assert.equal((await app.request("/config", { headers })).status, 200)
  const seeded = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: dir },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const execution = RayaTaskExecution.make(storage)
          const goals = RayaGoal.make({ storage, sessions })
          const agent = yield* runner.tasks.create({
            name: "GOAL_STOP café 日本語 😀",
            objective: "Retain unverified historical request",
            schedule: { kind: "manual" },
            enabled: false,
            tools: [],
            access: "brief",
          })
          const id = crypto.randomUUID()
          const trigger = { kind: "manual" as const }
          const session = yield* sessions.create({
            metadata: {
              rayaRoutine: {
                version: 2,
                agentID: agent.id,
                runID: id,
                scheduleVersion: agent.scheduleVersion ?? 1,
                trigger,
              },
            },
          })
          const row = {
            id,
            agentID: agent.id,
            sessionID: session.id,
            at: Date.now(),
            status: "running" as const,
            scheduleVersion: agent.scheduleVersion ?? 1,
            trigger,
          }
          yield* runner.tasks.record(row)
          const goal = yield* goals.create(session.id, "Retain stopped café 日本語 😀")
          const edited = yield* goals.edit(session.id, { status: "paused", expectedIntent: goal.intent! })
          const permit = yield* execution.acquire(row)
          assert(permit)
          yield* execution.enter(row, Effect.void)
          // Real terminal writer retains the exact idle execution for the public Stop to retire.
          const current = (yield* runner.tasks.runsFor(agent.id)).find((item) => item.id === id)!
          assert(yield* runner.tasks.transition(current, { ...current, status: "error" }))
          return { sessionID: session.id, agentID: agent.id, runID: id, intent: edited.state.intent }
        }),
      ),
    ),
  )
  const stopped = await app.request(`/session/${seeded.sessionID}/goal/stop`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedIntent: seeded.intent }),
  })
  assert.equal(stopped.status, 200)
  const receipt = await stopped.json()
  assert.equal(receipt.phase, "finished")
  assert.equal(receipt.task.runs[0].id, seeded.runID)
  const startup = before ? { before, after: await cycle() } : undefined
  if (startup) assert.equal(startup.after.cycle, startup.before.cycle + 1)
  await writeFile(witness, JSON.stringify({ seeded, receipt, startup }))
  return { seeded, receipt }
}
