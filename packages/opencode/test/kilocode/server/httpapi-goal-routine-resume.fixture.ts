import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { Server } from "@/server/server"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { finish } from "@/kilocode/cli/finish"

const root = process.env.RAYA_RESUME_PROFILE
const directory = process.env.RAYA_RESUME_WORKSPACE
if (!root || !directory) throw new Error("Owned resume profile missing")
const refusals: unknown[] = []
try {
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-kilo-directory": directory }
  const request = (method: string, route: string, body?: unknown) =>
    app.request(route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  expect((await request("GET", "/config")).status).toBe(200)
  const run = <A, E>(
    body: Effect.Effect<A, E, Database.Service | Storage.Service | Session.Service | Global.Service>,
  ) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide({ directory }, body)))
  const seed = await run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const rows = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
      expect(rows.find((row) => row.name === "main")?.file).toBe(path.join(root, "raya.db"))
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ database, storage })
      const goals = RayaGoal.make({ database, storage, sessions })
      const snapshots = RayaTaskSnapshot.make({ storage })
      const reports = RayaRoutineReports.make({ storage, sessions })
      const source = yield* sessions.create({})
      const create = (terminal: boolean) =>
        Effect.gen(function* () {
          const agent = yield* tasks.create({
            name: terminal ? "Provider-error worker" : "Pending worker",
            objective: "Retain the current verified assignment",
            enabled: true,
            schedule: { kind: "manual" },
            access: "brief",
            tools: [],
            sourceSessionID: source.id,
          })
          const id = crypto.randomUUID()
          const trigger = { kind: "manual" as const }
          const session = yield* sessions.create({
            metadata: { rayaRoutine: { version: 2, agentID: agent.id, runID: id, scheduleVersion: 1, trigger } },
          })
          const goal = yield* goals.create(
            session.id,
            agent.objective,
            undefined,
            undefined,
            undefined,
            undefined,
            terminal ? { modelCost: 1 } : undefined,
          )
          const reason =
            "Automatic continuation stopped after 3 provider errors. Resume the goal or send a message to continue."
          if (terminal) yield* goals.update(session.id, { status: "blocked", reason })
          if (!terminal) yield* goals.edit(session.id, { status: "paused", expectedIntent: goal.intent })
          const row = {
            id,
            agentID: agent.id,
            sessionID: session.id,
            at: Date.now(),
            status: terminal ? ("blocked" as const) : ("running" as const),
            scheduleVersion: 1,
            trigger,
            goalCreatedAt: goal.createdAt,
            ...(terminal
              ? { blockedReason: reason, outcome: { kind: "code" as const, summary: reason, cost: 0 } }
              : {}),
          }
          yield* tasks.record(row)
          yield* snapshots.save({
            version: 2,
            runID: id,
            agentID: agent.id,
            sessionID: session.id,
            at: row.at,
            definition: agent,
            objective: agent.objective,
          })
          yield* reports.publish({ agent, run: row })
          return { agent, row, goal: (yield* goals.get(session.id))! }
        })
      const terminal = yield* create(true)
      const pending = yield* create(false)
      const ordinary = yield* sessions.create({})
      const goal = yield* goals.create(ordinary.id, "Retain an ordinary paused goal")
      yield* goals.edit(ordinary.id, { status: "paused", expectedIntent: goal.intent })
      const mismatch = yield* sessions.create({ metadata: (yield* sessions.get(pending.row.sessionID)).metadata })
      const retained = yield* goals.create(mismatch.id, "Retain a session with mismatched worker identity")
      yield* goals.edit(mismatch.id, { status: "paused", expectedIntent: retained.intent })
      const malformed = yield* sessions.create({ metadata: { rayaRoutine: { version: "invalid" } } })
      const created = yield* goals.create(malformed.id, "Retain a session with malformed worker identity")
      yield* goals.edit(malformed.id, { status: "paused", expectedIntent: created.intent })
      return { goals, sessions, tasks, snapshots, reports, terminal, pending, ordinary, mismatch, malformed }
    }),
  )
  const read = () =>
    run(
      Effect.gen(function* () {
        return {
          goal: yield* seed.goals.get(seed.terminal.row.sessionID),
          runs: yield* seed.tasks.runsFor(seed.terminal.agent.id),
          snapshot: yield* seed.snapshots.find(seed.terminal.row.id),
          messages: yield* seed.sessions.messages({ sessionID: seed.terminal.row.sessionID }),
          card: yield* seed.reports
            .list(seed.terminal.agent.sourceSessionID!)
            .pipe(Effect.map((cards) => cards.filter((card) => card.id === seed.terminal.row.id))),
        }
      }),
    )
  const original = await read()
  const route = `/session/${seed.terminal.row.sessionID}/goal`
  const saved = await (await request("GET", route)).json()
  for (const body of [
    { status: "active", expectedIntent: "stale-intent" },
    { status: "active", expectedIntent: seed.terminal.goal.intent },
    { objective: "Changed work", expectedIntent: seed.terminal.goal.intent },
    {
      criteria: [{ id: "result", description: "Working result", verification: "Run checks", required: false }],
      expectedIntent: seed.terminal.goal.intent,
    },
    { budget: { modelCost: 2 }, budgetReason: "Allow the remaining work", expectedIntent: seed.terminal.goal.intent },
    { clearBudget: true, budgetReason: "Remove the current limit", expectedIntent: seed.terminal.goal.intent },
  ]) {
    const response = await request("PATCH", route, body)
    expect(response.status).toBe(409)
    refusals.push(await response.json())
    expect(await read()).toEqual(original)
    expect(await (await request("GET", route)).json()).toEqual(saved)
  }
  const unchanged = await request("PATCH", route, {
    objective: `  ${seed.terminal.goal.objective}  `,
    expectedIntent: seed.terminal.goal.intent,
  })
  expect(unchanged.status).toBe(200)
  expect(await unchanged.json()).toEqual(saved)
  expect(await read()).toEqual(original)
  for (const id of [seed.mismatch.id, seed.malformed.id]) {
    const prior = await run(seed.goals.get(id))
    expect(
      (await request("PATCH", `/session/${id}/goal`, { status: "active", expectedIntent: prior!.intent })).status,
    ).toBe(409)
    expect(await run(seed.goals.get(id))).toEqual(prior)
  }
  for (const id of [seed.pending.row.sessionID, seed.ordinary.id]) {
    const paused = await run(seed.goals.get(id))
    const response = await request("PATCH", `/session/${id}/goal`, { status: "active", expectedIntent: paused!.intent })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "active", objective: paused!.objective })
  }
  expect(await run(seed.snapshots.find(seed.pending.row.id))).toMatchObject({
    runID: seed.pending.row.id,
    sessionID: seed.pending.row.sessionID,
  })
  expect(await read()).toEqual(original)
  const paused = await request("PATCH", route, {
    objective: "Review the remaining work without starting it",
    status: "paused",
    expectedIntent: seed.terminal.goal.intent,
  })
  expect(paused.status).toBe(200)
  expect(await paused.json()).toMatchObject({
    status: "paused",
    objective: "Review the remaining work without starting it",
  })
  // Keep the existing reviewed-reply HTTP assertions on the same actual physical Storage graph.
  const review = async () => {
    const created = await request("POST", "/session", {})
    expect(created.status).toBe(200)
    const session = await created.json()
    const id = SessionID.make(session.id)
    const route = `/session/${id}/goal`
    const response = await request("POST", route, { objective: "Original direction" })
    const body = await response.json()
    await Bun.write(path.join(root, "http-goal-create.json"), JSON.stringify({ status: response.status, body }))
    expect(response.status).toBe(200)
    const state = await run(Storage.Service.use((storage) => storage.read<RayaGoal.State>(["raya", "goal", id])))
    if (!state.intent) throw new Error("The actual goal did not retain its intent")
    const marker = {
      version: 1 as const,
      dispatchID: "original-dispatch",
      messageID: MessageID.ascending(),
      oldIntent: "original-intent",
      intent: "blocked-intent",
      source: "attached-followup",
      outcome: "error" as const,
      execution: "a".repeat(64),
      at: Date.now(),
    }
    const saved = {
      ...state,
      dispatch: {
        id: marker.dispatchID,
        messageID: marker.messageID,
        intent: marker.oldIntent,
        phase: "finished" as const,
        queuedAt: marker.at,
      },
      replyRecovery: marker,
      status: "blocked" as const,
      intent: marker.intent,
    }
    const write = (value: RayaGoal.State) =>
      run(Storage.Service.use((storage) => storage.replace(["raya", "goal", id], value)))
    await write(saved)
    for (const body of [
      { status: "active", expectedIntent: marker.intent, objective: "Changed during review" },
      { status: "active", expectedIntent: marker.intent, budget: { modelCost: 2 }, budgetReason: "Changed limit" },
      { status: "active", expectedIntent: "stale" },
    ])
      expect((await request("PATCH", route, body)).status).toBe(409)
    const reviewed = {
      ...saved,
      status: "active" as const,
      intent: state.intent,
      replyRecovery: { ...marker, reviewedAt: marker.at, reviewIntent: state.intent },
    }
    await write(reviewed)
    const retry = await request("PATCH", route, { status: "active", expectedIntent: marker.intent })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ intent: state.intent, objective: state.objective })
    const changed = await request("PATCH", route, {
      status: "active",
      expectedIntent: state.intent,
      objective: "New reviewed direction",
      budget: { modelCost: 2 },
      budgetReason: "Allow the remaining work",
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ objective: "New reviewed direction", budget: { modelCost: 2 } })
    expect(
      (await request("PATCH", route, { status: "active", expectedIntent: state.intent, objective: "Stale edit" }))
        .status,
    ).toBe(409)
    await write({ ...reviewed, status: "complete" })
    const terminal = await request("PATCH", route, { status: "active", expectedIntent: marker.intent })
    expect(terminal.status).toBe(200)
    expect(await terminal.json()).toMatchObject({ status: "complete", intent: state.intent })
    expect(
      (await request("PATCH", route, { status: "active", expectedIntent: state.intent, objective: "Resurrect" }))
        .status,
    ).toBe(400)
  }
  await review()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
await finish(
  [
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
      await KiloShutdown.run()
      await AppRuntime.dispose()
    },
  ],
  () =>
    Bun.write(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: Number(process.exitCode ?? 0) === 0,
        pid: process.pid,
        physical: path.join(root, "raya.db"),
        refusals,
      }),
    ).then(() => {}),
)
