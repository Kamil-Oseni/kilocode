import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { AppRuntime } from "@/effect/app-runtime"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { posted, status } from "@/kilocode/task/inbox"
import { scheduler } from "@/kilocode/task/scheduler"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { receipts } from "@/kilocode/goal/stop-receipt"
import { InstanceStore } from "@/project/instance-store"
import { Server } from "@/server/server"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { retire } from "@/kilocode/cli/database-retirement"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { disposeAllInstances, disposeTestRuntime, tmpdir } from "../fixture/fixture"
import { remove as cleanup } from "./cleanup"

const previous = Flag.KILO_DB
const db = path.join(os.tmpdir(), `raya-goal-stop-${process.pid}-${crypto.randomUUID()}.sqlite`)
beforeAll(() => {
  if (previous !== ":memory:") throw new Error("Goal Stop fixture requires the isolated unit preload")
  Flag.KILO_DB = db
})

afterEach(async () => {
  await disposeAllInstances()
})

afterAll(async () => {
  try {
    await disposeAllInstances()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "instances-closed")
    await disposeTestRuntime()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "test-runtime-closed")
    if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "http-closed")
    await KiloShutdown.run()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "producers-closed")
    await AppRuntime.dispose()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "app-closed")
    await retire()
    console.info("GOAL_STOP_FIXTURE_RETIREMENT", "databases-closed")
  } finally {
    Flag.KILO_DB = previous
  }
  console.info("GOAL_STOP_FIXTURE_RETIREMENT", "selection-restored")
  console.info("GOAL_STOP_FIXTURE_RETIREMENT", "disk-cleanup-start")
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(cleanup))
  console.info("GOAL_STOP_FIXTURE_RETIREMENT", "disk-cleanup-complete")
}, 30_000)

for (const fault of [false, true])
  test.skipIf(fault && process.platform !== "win32")(
    `public Goal Stop ${fault ? "retries a real execution-file release failure using its durable original pin" : "retires an established idle manual run without accepting a result or touching another run"}`,
    async () => {
      await using dir = await tmpdir({ config: { formatter: false, lsp: false, enabled_providers: [] } })
      const app = Server.Default().app
      const headers = { "content-type": "application/json", "x-kilo-directory": dir.path }
      const request = (route: string, value: unknown) =>
        app.request(route, { method: "POST", headers, body: JSON.stringify(value) })
      // Establish the genuine production instance before admitting the actual writers below.
      expect((await app.request("/config", { headers })).status).toBe(200)
      const run = <A, E>(
        body: Effect.Effect<A, E, Database.Service | Storage.Service | Session.Service | Global.Service>,
      ) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide({ directory: dir.path }, body)))
      const seed = await run(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const physical = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
          expect(physical.find((row) => row.name === "main")?.file).toBe(db)
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const execution = RayaTaskExecution.make(storage)
          const owned: Parameters<typeof execution.finish>[0][] = []
          const goals = RayaGoal.make({ storage, sessions })
          const schedule = scheduler({ database, storage })
          const queue = RayaTaskQueue.make(database)
          const create = (name: string, timed = false) =>
            Effect.gen(function* () {
              const target = yield* sessions.create({ title: `${name} reports` })
              const agent = yield* runner.tasks.create({
                name,
                objective: "Retain an interrupted manual request",
                enabled: true,
                schedule: timed ? { kind: "cron", expr: "* * * * *", tz: "UTC" } : { kind: "manual" },
                ...(timed ? { overlap: "skip" as const, missed: "skip" as const } : {}),
                access: "brief",
                tools: [],
                sourceSessionID: target.id,
                reportSessionID: target.id,
              })
              const id = crypto.randomUUID()
              const at = Date.now()
              // A model-free queue fixture observes a chosen future interval;
              // this is not evidence of a genuine elapsed timer period.
              const from = Date.now() + 120_000
              const due = timed ? yield* schedule.prepare(agent.id, from) : undefined
              if (timed && !due) throw new Error("Actual scheduled queue fixture was not admitted")
              const trigger = due ?? { kind: "manual" as const }
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
                at,
                agentID: agent.id,
                sessionID: session.id,
                status: "running" as const,
                scheduleVersion: agent.scheduleVersion ?? 1,
                trigger,
              }
              const created = yield* goals.create(session.id, "Keep the unverified request pending")
              // A genuinely paused Goal keeps the production routine poller from starting a turn.
              const edited = yield* goals.edit(session.id, { status: "paused", expectedIntent: created.intent! })
              const goal = edited.state
              yield* RayaTaskSnapshot.make({ storage }).save({
                version: 2,
                runID: row.id,
                agentID: agent.id,
                sessionID: session.id,
                at,
                definition: agent,
                objective: goal.objective,
              })
              if (due) {
                yield* schedule.reserve(due, row.id)
                yield* schedule.link(due, row.id, session.id)
              }
              yield* runner.tasks.record(row)
              const permit = yield* execution.acquire(row)
              if (!permit) throw new Error("Actual idle execution admission was refused")
              yield* execution.enter(row, Effect.void)
              owned.push(row)
              expect((yield* execution.receipt(row))?.state).toBe("idle")
              if (fault) {
                const current = (yield* runner.tasks.runsFor(agent.id)).find((entry) => entry.id === row.id)
                if (!current) throw new Error("The actual recorded run was not retained")
                expect(yield* runner.tasks.transition(current, { ...current, status: "error" })).toBe(true)
              }
              return { agent, row, goal, target, from }
            })
          return {
            runner,
            execution,
            owned,
            goals,
            sessions,
            storage,
            create,
            schedule,
            queue,
            database,
            data: (yield* Global.Service).data,
            selected: yield* create("Selected"),
            other: yield* create("Other"),
          }
        }),
      )
      const selected = seed.selected
      const original = await run(seed.execution.receipt(selected.row))
      const other = await run(seed.execution.receipt(seed.other.row))
      const route = `/session/${selected.row.sessionID}/goal/stop`
      const file = path.join(
        seed.data,
        "storage",
        "raya",
        "agent-executions",
        `${createHash("sha256").update(selected.row.id).digest("hex")}.json`,
      )
      const child = fault
        ? Bun.spawn(
            [
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$handle=[IO.File]::Open('${file.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Write)); try { [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $handle.Dispose() }`,
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
          )
        : undefined
      try {
        if (child) {
          expect(await Bun.file(file).json()).toEqual(original)
          const reader = child.stdout.getReader()
          const ready = await Promise.race([
            reader.read(),
            Bun.sleep(5000).then(() => {
              throw new Error("Execution file holder did not become ready")
            }),
          ])
          expect(new TextDecoder().decode(ready.value).trim()).toBe("held")
          reader.releaseLock()
        }
        expect((await request(route, { expectedIntent: crypto.randomUUID() })).status).toBe(409)
        expect(await run(seed.runner.tasks.runsFor(selected.agent.id))).toContainEqual(
          expect.objectContaining({ id: selected.row.id, status: fault ? "error" : "running" }),
        )
        expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
        expect(await run(seed.execution.receipt(selected.row))).toEqual(original)
        if (child) {
          const failed = await request(route, { expectedIntent: selected.goal.intent ?? "unset" })
          expect(failed.status).toBe(409)
          expect(await run(seed.goals.get(selected.row.sessionID))).toBeUndefined()
          const pending = await run(seed.goals.stopResult(selected.row.sessionID))
          expect(pending).toMatchObject({
            phase: "cleared",
            interrupted: false,
            task: {
              version: 1,
              runs: [{ id: selected.row.id, agentID: selected.agent.id, sessionID: selected.row.sessionID }],
            },
          })
          expect(await run(seed.execution.receipt(selected.row))).toEqual(original)
          expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
          await child.stdin.write("\n")
          await child.stdin.end()
          expect(await child.exited).toBe(0)
          if (!pending?.task) throw new Error("The actual cleared stop did not retain its task pin")
          const key = [
            "raya",
            "goal-stops",
            selected.row.sessionID,
            createHash("sha256").update(selected.goal.intent!).digest("hex"),
          ]
          const changed = {
            ...pending,
            task: {
              ...pending.task,
              runs: pending.task.runs.map((row) => ({ ...row, executionDigest: "0".repeat(64) })),
            },
          }
          await run(seed.storage.replace(key, changed))
          expect((await request(route, { expectedIntent: selected.goal.intent! })).status).toBe(409)
          expect(await run(seed.execution.receipt(selected.row))).toEqual(original)
          expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
          expect((await run(seed.goals.stopResult(selected.row.sessionID)))?.phase).toBe("cleared")
          await run(seed.storage.replace(key, pending))
        }
        if (!fault)
          await run(
            receipts(seed.storage).save({
              sessionID: selected.row.sessionID,
              intent: selected.goal.intent!,
              phase: "requested",
              at: Date.now() - 60_000,
            }),
          )
        const response = await request(route, { expectedIntent: selected.goal.intent ?? "unset" })
        expect(response.status).toBe(200)
        const receipt = await response.json()
        expect(receipt).toMatchObject({
          sessionID: selected.row.sessionID,
          intent: selected.goal.intent,
          phase: "finished",
        })
        expect(await run(seed.goals.get(selected.row.sessionID))).toBeUndefined()
        expect(await run(seed.runner.tasks.runsFor(selected.agent.id))).toContainEqual(
          expect.objectContaining({
            id: selected.row.id,
            sessionID: selected.row.sessionID,
            status: fault ? "error" : "stopped",
          }),
        )
        if (!fault) {
          // A retained request may predate its first routine pin publication.
          expect(receipt.task.stop.at).toBeGreaterThan(receipt.at)
          const history = await run(seed.runner.tasks.runsFor(selected.agent.id))
          const stopped = history.find((row) => row.id === selected.row.id)!
          expect(stopped.stop).toMatchObject({ version: 1, intent: selected.goal.intent })
          expect(stopped.blockedReason).toBeUndefined()
          expect(stopped.outcome?.summary).toBe("Stopped by the user. No unverified result was accepted.")
          expect(stopped.outcome?.verification).toBeUndefined()
          expect(status(selected.agent, stopped)).toBe("scheduled")
          expect(status({ ...selected.agent, enabled: false }, stopped)).toBe("paused")
          expect(posted(stopped)).toMatchObject({
            kind: "report",
            body: stopped.outcome!.summary,
            sessionID: selected.row.sessionID,
          })
          const reports = await app.request(`/kilocode/agent-reports?sessionID=${selected.target.id}`, { headers })
          expect(reports.status).toBe(200)
          expect(await reports.json()).toContainEqual(
            expect.objectContaining({
              runID: selected.row.id,
              status: "stopped",
              summary: stopped.outcome!.summary,
            }),
          )
          expect(
            await run(seed.runner.tasks.transition(stopped, { ...stopped, status: "running", stop: undefined })),
          ).toBe(false)
          expect(await run(seed.runner.tasks.recall(selected.agent.id))).not.toContain(stopped.outcome!.summary)
        }
        expect(await run(seed.execution.receipt(selected.row))).toBeUndefined()
        expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
        if (!fault) {
          const orphan = await run(seed.create("Missing Goal"))
          try {
            const pin = await run(seed.runner.stopGoal((tasks) => tasks.prepare(orphan.row.sessionID)))
            expect(pin.stop?.intent).toBe(orphan.goal.intent)
            await run(seed.goals.clear(orphan.row.sessionID, orphan.goal.intent!))
            const finish = (value: typeof pin) =>
              run(seed.runner.stopGoal((tasks) => tasks.finish(orphan.row.sessionID, value, false)).pipe(Effect.exit))
            expect((await finish(pin))._tag).toBe("Failure")
            const record = {
              sessionID: orphan.row.sessionID,
              intent: orphan.goal.intent!,
              phase: "cleared" as const,
              at: Date.now(),
              task: pin,
            }
            const archive = receipts(seed.storage)
            await run(archive.save(record))
            expect((await finish(pin))._tag).toBe("Failure")
            await run(seed.runner.settle(orphan.row.sessionID))
            expect(await run(seed.runner.tasks.runsFor(orphan.agent.id))).toContainEqual(
              expect.objectContaining({ id: orphan.row.id, status: "running" }),
            )
            await run(archive.save({ ...record, interrupted: false }))
            for (const changed of [
              { ...pin, stop: { ...pin.stop!, intent: selected.goal.intent! } },
              { ...pin, runs: pin.runs.map((row) => ({ ...row, id: crypto.randomUUID() })) },
              { ...pin, runs: pin.runs.map((row) => ({ ...row, executionDigest: "0".repeat(64) })) },
            ])
              expect((await finish(changed))._tag).toBe("Failure")
            expect(await run(seed.runner.tasks.runsFor(orphan.agent.id))).toContainEqual(
              expect.objectContaining({ id: orphan.row.id, status: "running" }),
            )
            await run(
              seed.storage.remove([
                "raya",
                "goal-stops",
                orphan.row.sessionID,
                createHash("sha256").update(orphan.goal.intent!).digest("hex"),
              ]),
            )
            await run(seed.runner.settle(orphan.row.sessionID))
            const missing = (await run(seed.runner.tasks.runsFor(orphan.agent.id))).find(
              (row) => row.id === orphan.row.id,
            )!
            expect(missing.status).toBe("error")
            expect(missing.stop).toBeUndefined()
            expect(missing.blockedReason).toContain("No saved goal")
          } finally {
            await run(seed.execution.finish(orphan.row))
          }
          const timer = await run(seed.create("Scheduled Stop", true))
          try {
            if (timer.row.trigger.kind !== "timer") throw new Error("Actual timer fixture required")
            expect((await run(seed.queue.get(timer.row.trigger.id)))?.state).toBe("linked")
            const stopped = await request(`/session/${timer.row.sessionID}/goal/stop`, {
              expectedIntent: timer.goal.intent!,
            })
            expect(stopped.status).toBe(200)
            expect(await stopped.json()).toMatchObject({
              phase: "finished",
              task: { stop: { intent: timer.goal.intent } },
            })
            expect((await run(seed.queue.get(timer.row.trigger.id)))?.state).toBe("complete")
            expect(await run(seed.runner.tasks.get(timer.agent.id))).toMatchObject({
              enabled: true,
              scheduleVersion: timer.agent.scheduleVersion,
              schedule: timer.agent.schedule,
            })
            const reopened = scheduler({ database: seed.database, storage: seed.storage })
            expect(await run(reopened.prepare(timer.agent.id, timer.from))).toBeUndefined()
            const next = await run(reopened.prepare(timer.agent.id, timer.from + 60_000))
            expect(next?.kind).toBe("timer")
            expect(next?.id).not.toBe(timer.row.trigger.id)
            if (next) await run(seed.queue.skip(next.id, "Unstarted source fixture cleanup."))
            expect((await run(seed.runner.tasks.runsFor(timer.agent.id))).map((row) => row.status)).toEqual(["stopped"])
          } finally {
            await run(seed.execution.finish(timer.row))
          }
          const invalid = await run(seed.create("Unverified stopped history", true))
          try {
            if (invalid.row.trigger.kind !== "timer") throw new Error("Actual timer fixture required")
            const pin = await run(seed.runner.stopGoal((tasks) => tasks.prepare(invalid.row.sessionID)))
            if (!pin.stop) throw new Error("Actual original pending Stop pin required")
            const before = await run(seed.execution.receipt(invalid.row))
            await run(seed.goals.clear(invalid.row.sessionID, invalid.goal.intent!))
            // Deliberately seed an untrusted historical terminal row, never an
            // accepted Stop. A status label cannot retire its actual owner.
            const current = (await run(seed.runner.tasks.runsFor(invalid.agent.id)))[0]
            expect(
              await run(seed.runner.tasks.transition(current, { ...current, status: "stopped", stop: pin.stop })),
            ).toBe(true)
            for (const present of [false, true]) {
              if (present)
                await run(
                  receipts(seed.storage).save({
                    sessionID: invalid.row.sessionID,
                    intent: invalid.goal.intent!,
                    phase: "finished",
                    at: Date.now(),
                    finishedAt: Date.now(),
                    interrupted: false,
                    task: { ...pin, sessionDigest: "0".repeat(64) },
                  }),
                )
              await run(seed.runner.settle(invalid.row.sessionID))
              expect(await run(seed.execution.receipt(invalid.row))).toEqual(before)
              expect((await run(seed.queue.get(invalid.row.trigger.id)))?.state).toBe("linked")
            }
            await run(seed.execution.finish(invalid.row))
            if (!(await run(seed.execution.acquire(invalid.row))))
              throw new Error("Actual successor owner was not acquired")
            await run(seed.execution.enter(invalid.row, Effect.void))
            const renewed = await run(seed.execution.receipt(invalid.row))
            expect(renewed?.token).not.toBe(before?.token)
            await run(
              receipts(seed.storage).save({
                sessionID: invalid.row.sessionID,
                intent: invalid.goal.intent!,
                phase: "finished",
                at: Date.now(),
                finishedAt: Date.now(),
                interrupted: false,
                task: pin,
              }),
            )
            await run(seed.runner.settle(invalid.row.sessionID))
            expect(await run(seed.execution.receipt(invalid.row))).toEqual(renewed)
            expect((await run(seed.queue.get(invalid.row.trigger.id)))?.state).toBe("linked")
          } finally {
            await run(seed.execution.finish(invalid.row))
          }
        }
        expect((await run(seed.sessions.get(selected.row.sessionID))).id).toBe(selected.row.sessionID)
        expect(await run(seed.sessions.messages({ sessionID: selected.row.sessionID }))).toEqual([])
        const created = await run(seed.goals.create(selected.row.sessionID, "Explicit new goal in the retained chat"))
        const edited = await run(
          seed.goals.edit(selected.row.sessionID, { status: "paused", expectedIntent: created.intent! }),
        )
        const renewed = edited.state
        expect(renewed.intent).not.toBe(selected.goal.intent)
        const fresh = await run(seed.runner.ask(selected.agent.id, "Explicit fresh request", { defer: true }))
        seed.owned.push(fresh)
        expect(fresh.id).not.toBe(selected.row.id)
        expect(fresh.sessionID).not.toBe(selected.row.sessionID)
        const repeated = await request(route, { expectedIntent: selected.goal.intent ?? "unset" })
        expect(repeated.status).toBe(200)
        expect(await repeated.json()).toEqual(receipt)
        expect(await run(seed.goals.get(selected.row.sessionID))).toEqual(renewed)
        expect(await run(seed.runner.tasks.runsFor(selected.agent.id))).toContainEqual(
          expect.objectContaining({ id: fresh.id, sessionID: fresh.sessionID, status: "running" }),
        )
        expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
      } finally {
        if (child && child.exitCode === null) {
          await child.stdin.write("\n")
          await child.stdin.end()
          expect(await child.exited).toBe(0)
        }
        // Stop each source-created Goal while its real instance, input owner
        // and SQLite selection still exist. Dispose must not revive an armed
        // deferred request after its workspace has already been removed.
        for (const row of seed.owned.toReversed()) {
          const goal = await run(seed.goals.get(SessionID.make(row.sessionID)))
          if (goal) {
            const stopped = await request(`/session/${row.sessionID}/goal/stop`, {
              expectedIntent: goal.intent ?? "unset",
            })
            expect(stopped.status).toBe(200)
          }
          await run(seed.execution.finish(row))
        }
      }
    },
    30_000,
  )
