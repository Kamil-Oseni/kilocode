import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { AppRuntime } from "@/effect/app-runtime"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceStore } from "@/project/instance-store"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

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
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const execution = RayaTaskExecution.make(storage)
          const goals = RayaGoal.make({ storage, sessions })
          const create = (name: string) =>
            Effect.gen(function* () {
              const agent = yield* runner.tasks.create({
                name,
                objective: "Retain an interrupted manual request",
                enabled: true,
                schedule: { kind: "manual" },
                access: "brief",
                tools: [],
              })
              const id = crypto.randomUUID()
              const at = Date.now()
              const session = yield* sessions.create({
                metadata: {
                  rayaRoutine: {
                    version: 2,
                    agentID: agent.id,
                    runID: id,
                    scheduleVersion: agent.scheduleVersion ?? 1,
                    trigger: { kind: "manual" },
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
                trigger: { kind: "manual" as const },
              }
              const created = yield* goals.create(session.id, "Keep the unverified request pending")
              // A genuinely paused Goal keeps the production routine poller from starting a turn.
              const edited = yield* goals.edit(session.id, { status: "paused", expectedIntent: created.intent! })
              const goal = edited.state
              yield* runner.tasks.record(row)
              const permit = yield* execution.acquire(row)
              if (!permit) throw new Error("Actual idle execution admission was refused")
              yield* execution.enter(row, Effect.void)
              expect((yield* execution.receipt(row))?.state).toBe("idle")
              if (fault) {
                const current = (yield* runner.tasks.runsFor(agent.id)).find((entry) => entry.id === row.id)
                if (!current) throw new Error("The actual recorded run was not retained")
                expect(yield* runner.tasks.transition(current, { ...current, status: "error" })).toBe(true)
              }
              return { agent, row, goal }
            })
          return {
            runner,
            execution,
            goals,
            sessions,
            storage,
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
          child.stdin.write("\n")
          child.stdin.end()
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
          expect.objectContaining({ id: selected.row.id, sessionID: selected.row.sessionID, status: "error" }),
        )
        expect(await run(seed.execution.receipt(selected.row))).toBeUndefined()
        expect(await run(seed.execution.receipt(seed.other.row))).toEqual(other)
        expect((await run(seed.sessions.get(selected.row.sessionID))).id).toBe(selected.row.sessionID)
        expect(await run(seed.sessions.messages({ sessionID: selected.row.sessionID }))).toEqual([])
        const created = await run(seed.goals.create(selected.row.sessionID, "Explicit new goal in the retained chat"))
        const edited = await run(
          seed.goals.edit(selected.row.sessionID, { status: "paused", expectedIntent: created.intent! }),
        )
        const renewed = edited.state
        expect(renewed.intent).not.toBe(selected.goal.intent)
        const fresh = await run(seed.runner.ask(selected.agent.id, "Explicit fresh request", { defer: true }))
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
          child.stdin.write("\n")
          child.stdin.end()
          expect(await child.exited).toBe(0)
        }
        await run(seed.execution.finish(selected.row))
        await run(seed.execution.finish(seed.other.row))
      }
    },
    30_000,
  )
