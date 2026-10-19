import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

const [root, mode] = process.argv.slice(2)
assert(root && path.isAbsolute(root) && mode && ["fault", "cold", "recover"].includes(mode))
assert(path.basename(root).startsWith("raya-stop-report-crash-"))
assert.equal(process.env.RAYA_DB, path.join(root, "runtime.sqlite"))
for (const [key, leaf] of [
  ["HOME", "home"],
  ["USERPROFILE", "home"],
  ["APPDATA", "roaming"],
  ["LOCALAPPDATA", "local"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_CACHE_HOME", "cache"],
  ["XDG_RUNTIME_DIR", "runtime"],
  ["TEMP", "tmp"],
  ["TMP", "tmp"],
] as const) {
  assert.equal(process.env[key], path.join(root, leaf))
  await fs.mkdir(path.join(root, leaf), { recursive: true })
}
const workspace = path.join(root, "workspace")
await fs.mkdir(workspace, { recursive: true })
// All production imports follow the private environment and physical directories.
const { Effect, Schema } = await import("effect")
const { sql } = await import("drizzle-orm")
const { Database } = await import("@opencode-ai/core/database/database")
const { durable, stopped } = await import("@/kilocode/task/owner")
const { AppRuntime } = await import("@/effect/app-runtime")
const { InstanceStore } = await import("@/project/instance-store")
const { Server } = await import("@/server/server")
const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
const { KiloShutdown } = await import("@/kilocode/cli/shutdown")
const { retire } = await import("@/kilocode/cli/database-retirement")
const { lifecycle } = await import("@/kilocode/cli/lifecycle")
const { Storage } = await import("@/storage/storage")
const { Session } = await import("@/session/session")
const { SessionID } = await import("@/session/schema")
const { RayaGoal } = await import("@/kilocode/goal")
const { RayaTask } = await import("@/kilocode/task")
const { RayaTaskRunner } = await import("@/kilocode/task/runner")
const { RayaTaskExecution } = await import("@/kilocode/task/execution")
const { RayaTaskSnapshot } = await import("@/kilocode/task/snapshot")
const { RayaTaskInbox } = await import("@/kilocode/task/inbox")
const { RayaTaskQueue } = await import("@/kilocode/task/queue")
const { scheduler } = await import("@/kilocode/task/scheduler")
const { receipts } = await import("@/kilocode/goal/stop-receipt")

const identity = durable()
assert(identity.birth)
await fs.writeFile(path.join(root, `${mode}-epoch.json`), JSON.stringify(identity), { flag: "wx" })
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: false })
const headers = {
  Authorization: `Basic ${Buffer.from(`kilo:${process.env.KILO_SERVER_PASSWORD}`).toString("base64")}`,
  "content-type": "application/json",
  "x-kilo-directory": workspace,
}
const request = (route: string, body?: unknown) =>
  fetch(new URL(route, listener.url), {
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  })
const run = <A, E>(
  body: import("effect").Effect.Effect<
    A,
    E,
    | import("@opencode-ai/core/database/database").Database.Service
    | import("@/storage/storage").Storage.Service
    | import("@/session/session").Session.Service
  >,
) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide({ directory: workspace }, body)))

const failures: unknown[] = []
try {
  assert.equal((await request("/config")).status, 200)
  const services = await run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const physical = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
      assert.equal(physical.find((row) => row.name === "main")?.file, path.join(root, "runtime.sqlite"))
      return {
        database,
        storage,
        sessions,
        runner: RayaTaskRunner.make({ database, storage, sessions }),
        execution: RayaTaskExecution.make(storage),
        goals: RayaGoal.make({ storage, sessions }),
        queue: RayaTaskQueue.make(database),
        inbox: RayaTaskInbox.make(database),
      }
    }),
  )
  const binding = Schema.Struct({ run: RayaTask.Run, foreign: RayaTask.Run, target: SessionID, intent: Schema.String })
  const file = path.join(root, "binding.json")
  const saved =
    mode === "fault"
      ? await run(
          Effect.gen(function* () {
            const target = yield* services.sessions.create({ title: "Original stopped report destination" })
            const create = (foreign: boolean) =>
              Effect.gen(function* () {
                const at = Date.now()
                const from = at + 10 * 60_000
                const agent = yield* services.runner.tasks.create({
                  name: foreign
                    ? "Unrelated terminal error with retained active evidence"
                    : "Original interrupted report",
                  objective: "Retain an unverified stopped request",
                  enabled: !foreign,
                  schedule: foreign ? { kind: "manual" } : { kind: "once", at: from },
                  access: "brief",
                  tools: [],
                  sourceSessionID: target.id,
                  reportSessionID: target.id,
                })
                const schedule = scheduler({ database: services.database, storage: services.storage })
                const due = foreign ? undefined : yield* schedule.prepare(agent.id, from)
                if (!foreign) assert(due)
                const trigger = due ?? { kind: "manual" as const }
                const id = crypto.randomUUID()
                const session = yield* services.sessions.create({
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
                const goal = yield* services.goals.create(session.id, "Unverified fixture work must never continue")
                const paused = yield* services.goals.edit(session.id, {
                  status: "paused",
                  expectedIntent: goal.intent!,
                })
                const row = {
                  id,
                  agentID: agent.id,
                  sessionID: session.id,
                  at,
                  status: "running" as const,
                  scheduleVersion: agent.scheduleVersion ?? 1,
                  trigger,
                }
                yield* RayaTaskSnapshot.make({ storage: services.storage }).save({
                  version: 2,
                  runID: id,
                  agentID: agent.id,
                  sessionID: session.id,
                  at,
                  definition: agent,
                  objective: goal.objective,
                })
                if (due) {
                  yield* schedule.reserve(due, id)
                  yield* schedule.link(due, id, session.id)
                }
                yield* services.runner.tasks.record(row)
                assert(yield* services.execution.acquire(row))
                if (!foreign) yield* services.execution.enter(row, Effect.void)
                if (foreign) {
                  // A real failed execution retains active uncertainty. Give its run a
                  // real terminal error transition so normal continuing-run reclamation
                  // is outside this negative case; never forge or delete its owner.
                  const failed = yield* services.execution
                    .enter(row, Effect.fail(new Error("Unrelated fixture body failed")))
                    .pipe(Effect.exit)
                  assert.equal(failed._tag, "Failure")
                  const current = (yield* services.runner.tasks.runsFor(agent.id))[0]
                  assert(current)
                  assert(
                    yield* services.runner.tasks.transition(current, {
                      ...current,
                      status: "error",
                      blockedReason: "The unrelated fixture body failed without a verified result.",
                    }),
                  )
                }
                // Fence scheduled dispatch while preserving this occurrence's original version.
                if (!foreign) yield* services.runner.tasks.update(agent.id, { enabled: false })
                return { row: (yield* services.runner.tasks.runsFor(agent.id))[0], intent: paused.state.intent! }
              })
            const selected = yield* create(false)
            const foreign = yield* create(true)
            return { run: selected.row, foreign: foreign.row, target: target.id, intent: selected.intent }
          }),
        )
      : Schema.decodeUnknownSync(binding)(JSON.parse(await fs.readFile(file, "utf8")))
  if (mode === "fault") await fs.writeFile(file, JSON.stringify(saved), { flag: "wx" })
  const route = `/session/${saved.run.sessionID}/goal/stop`
  const inspect = async () => {
    const state = await run(
      Effect.gen(function* () {
        const run = (yield* services.runner.tasks.runsFor(saved.run.agentID)).find((row) => row.id === saved.run.id)
        const foreign = (yield* services.runner.tasks.runsFor(saved.foreign.agentID)).find(
          (row) => row.id === saved.foreign.id,
        )
        const owner = yield* services.execution.receipt(saved.run)
        const held = yield* services.execution.receipt(saved.foreign)
        const receipt = yield* receipts(services.storage).read(saved.run.sessionID, saved.intent)
        const occurrence =
          saved.run.trigger?.kind === "timer" ? yield* services.queue.get(saved.run.trigger.id) : undefined
        const inbox = (yield* services.inbox.page(saved.run.agentID)).messages
        const sessions = yield* services.database.db.all<{ id: string }>("SELECT id FROM session ORDER BY id")
        const messages = yield* services.database.db.all<{ id: string }>("SELECT id FROM message ORDER BY id")
        return { run, foreign, owner, held, receipt, occurrence, inbox, sessions, messages }
      }),
    )
    const response = await request(`/kilocode/agent-reports?sessionID=${saved.target}`)
    assert.equal(response.status, 200)
    const cards = Schema.decodeUnknownSync(
      Schema.Array((await import("@/kilocode/task/projection")).RayaRoutineReports.Card),
    )(await response.json())
    return JSON.parse(JSON.stringify({ ...state, cards })) as typeof state & { cards: typeof cards }
  }
  const baseline = path.join(root, "cut.json")
  if (mode === "fault") {
    // Only the real worker inbox insertion is faulted; the ordinary Card precedes it.
    assert(/^[a-f0-9-]{36}$/.test(saved.run.id))
    assert(/^[a-f0-9-]{36}$/.test(saved.run.agentID))
    await run(
      services.database.db.run(
        sql.raw(
          `CREATE TRIGGER stop_report_fault BEFORE INSERT ON raya_routine_message WHEN NEW.agent_id = '${saved.run.agentID}' AND NEW.source = 'report:${saved.run.id}' BEGIN SELECT RAISE(ABORT, 'original stopped inbox insertion fault'); END`,
        ),
      ),
    )
    const response = await request(route, { expectedIntent: saved.intent })
    assert.equal(response.status, 500)
    const diagnostic = Schema.decodeUnknownSync(
      (await import("@opencode-ai/core/util/error")).NamedError.Unknown.Schema,
    )(await response.json())
    assert.equal(diagnostic.data.code, "server.unexpected")
    assert.match(diagnostic.data.ref ?? "", /^err_[a-f0-9]{8}$/)
    await fs.writeFile(
      path.join(root, "fault-http.json"),
      JSON.stringify({ status: response.status, response: diagnostic }),
      { flag: "wx" },
    )
    const cut = await inspect()
    assert.equal(cut.run?.status, "stopped")
    assert.deepEqual(cut.run?.stop, cut.receipt?.task?.stop)
    assert.equal(cut.run?.stop?.intent, saved.intent)
    assert.equal(cut.run?.outcome?.verification, undefined)
    assert.equal(cut.receipt?.phase, "cleared")
    assert.equal(cut.receipt?.interrupted, false)
    assert.equal(cut.occurrence?.state, "complete")
    assert.equal(cut.occurrence?.claim_id, saved.run.id)
    assert.equal(cut.occurrence?.session_id, saved.run.sessionID)
    assert.equal(cut.owner?.state, "idle")
    assert.equal(cut.held?.state, "active")
    assert.equal(cut.foreign?.status, "error")
    assert.equal(cut.foreign?.outcome, undefined)
    assert.equal(cut.inbox.filter((row) => row.source === `report:${saved.run.id}`).length, 0)
    assert.equal(cut.cards.filter((row) => row.runID === saved.run.id && row.status === "stopped").length, 1)
    assert.equal(cut.messages.length, 0)
    assert.equal((await request(`/session/${saved.run.sessionID}/goal`)).status, 404)
    await fs.writeFile(baseline, JSON.stringify(cut), { flag: "wx" })
    console.info("STOP_REPORT_CRASH_FAULT_VERIFIED")
    // Intentional original process crash: no listener/runtime/database finalizers.
    process.exit(86)
  }
  await run(services.database.db.run(sql`DROP TRIGGER IF EXISTS stop_report_fault`))
  const before = await inspect()
  assert.equal(JSON.stringify(before), await fs.readFile(baseline, "utf8"))
  assert(before.owner && stopped(before.owner.owner))
  // This unrelated terminal error's ACTIVE receipt belongs to dead E0,
  // not a still-live foreign backend or a continuing running-row recovery case.
  // Its uncertain original generation must remain retained exactly.
  assert(before.held && stopped(before.held.owner))
  await run(services.runner.revive())
  assert.deepEqual(await inspect(), before)
  if (mode === "recover") {
    const response = await request(route, { expectedIntent: saved.intent })
    assert.equal(response.status, 200)
    const receipt = Schema.decodeUnknownSync((await import("@/kilocode/goal/stop-receipt")).Receipt)(
      await response.json(),
    )
    assert.equal(receipt.phase, "finished")
    assert.deepEqual(receipt.task, before.receipt?.task)
    const after = await inspect()
    assert.deepEqual(after.run, before.run)
    assert.deepEqual(after.foreign, before.foreign)
    assert.deepEqual(after.held, before.held)
    assert.equal(after.owner, undefined)
    assert.deepEqual(after.cards, before.cards)
    assert.deepEqual(after.occurrence, before.occurrence)
    assert.deepEqual(after.sessions, before.sessions)
    assert.deepEqual(after.messages, before.messages)
    const reports = after.inbox.filter((row) => row.source === `report:${saved.run.id}`)
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.kind, "report")
    assert.equal(reports[0]?.body, "Stopped by the user. No unverified result was accepted.")
    const review = [
      "raya",
      "agent-execution-reviews",
      createHash("sha256").update(saved.run.id).digest("hex"),
      createHash("sha256").update(before.owner.token).digest("hex"),
    ]
    const archived = await run(services.storage.read<{ actor: string; record: typeof before.owner }>(review))
    assert.equal(archived.actor, "user")
    assert.deepEqual(archived.record, before.owner)
    const repeated = await request(route, { expectedIntent: saved.intent })
    assert.equal(repeated.status, 200)
    assert.deepEqual(await repeated.json(), receipt)
    assert.deepEqual(await inspect(), after)
    await run(services.runner.revive())
    assert.deepEqual(await inspect(), after)
  }
  console.info(`STOP_REPORT_CRASH_${mode.toUpperCase()}_VERIFIED`)
} catch (err) {
  failures.push(err)
} finally {
  // Ordered production cleanup retains every failure and still attempts later
  // persistence retirement. Transport close(true) is not a graceful TCP-drain claim.
  const [result] = await Promise.allSettled([
    lifecycle([
      () => listener.stop(true),
      () => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll())),
      async () => {
        if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
      },
      () => KiloShutdown.run(),
      () => AppRuntime.dispose(),
      () => retire(),
    ]).run(),
  ])
  if (result.status === "rejected") failures.push(result.reason)
  if (result.status === "fulfilled") console.info("STOP_REPORT_CRASH_OWNERS_CLOSED")
}
if (failures.length) throw new AggregateError(failures, "Stop-report fixture body or retirement failed")
