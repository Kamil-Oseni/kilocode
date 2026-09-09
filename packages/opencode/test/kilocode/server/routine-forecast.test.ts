import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineArchiveTable, RayaRoutineArchiveImportTable } from "@opencode-ai/core/kilocode/archive.sql"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Template } from "@/kilocode/task/templates"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { createHash } from "node:crypto"
import { AppRuntime } from "@/effect/app-runtime"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("routine capability errors identify the missing decision without saving a routine", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  for (const role of ["accountant", "inbox"]) {
    const response = await app.request("/kilocode/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Review", role, objective: "Review records", schedule: { kind: "manual" } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      kind: "capability",
      field: "capabilities",
      message: expect.any(String),
    })
  }
  const response = await app.request("/kilocode/agent", { headers })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
}, 30_000)

test("routine output contracts round-trip and reject invalid updates without replacing saved requirements", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const output = {
    destination: "conversation" as const,
    description: "Weekly document findings",
    criteria: [
      {
        id: "coverage",
        description: "Identify reviewed documents",
        verification: "List each source path and any unavailable files",
      },
    ],
  }
  const response = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Document review",
      objective: "Review documents",
      enabled: false,
      schedule: { kind: "manual" },
      output,
    }),
  })
  expect(response.status).toBe(200)
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await response.json())
  expect(agent.output).toEqual(output)
  for (const invalid of [
    { ...output, destination: "email" },
    { ...output, description: "   " },
    { ...output, criteria: [] },
    { ...output, criteria: [output.criteria[0], output.criteria[0]] },
    { ...output, criteria: [{ ...output.criteria[0], verification: "" }] },
  ]) {
    const rejected = await app.request(`/kilocode/agent/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ output: invalid }),
    })
    expect(rejected.status).toBe(400)
  }
  const changed = await app.request(`/kilocode/agent/${agent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Renamed" }),
  })
  expect(changed.status).toBe(200)
  const saved = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await changed.json())
  expect(saved.output).toEqual(output)
  expect(saved.enabled).toBe(false)
  const edited = { ...output, description: "Revised document review" }
  const conditional = await app.request(`/kilocode/agent/${agent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ output: edited, expectedOutput: output }),
  })
  expect(conditional.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await conditional.json()).output).toEqual(edited)
  for (const expectedOutput of [output, "unset"]) {
    const stale = await app.request(`/kilocode/agent/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ output, expectedOutput }),
    })
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({
      message: expect.stringContaining("output requirements changed"),
      kind: "conflict",
      field: "output",
    })
  }
  const legacy = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "No requirements yet",
      objective: "Work",
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  const previous = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await legacy.json())
  const initial = await app.request(`/kilocode/agent/${previous.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ output, expectedOutput: "unset" }),
  })
  expect(initial.status).toBe(200)
  const initialized = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await initial.json())
  expect(initialized.output).toEqual(output)
  expect(initialized.enabled).toBe(false)
  expect(initialized.schedule).toEqual(previous.schedule)
  expect(await (await app.request(`/kilocode/agent/${agent.id}/runs`, { headers })).json()).toEqual([])
}, 30_000)

test("starter workflows are editable schedule proposals and never activate routines", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const before = await (await app.request("/kilocode/agent", { headers })).json()
  const response = await app.request("/kilocode/agent-templates", { headers })
  expect(response.status).toBe(200)
  const templates = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Template)))(await response.json())
  expect(new Set(templates.map((item) => item.id)).size).toBe(templates.length)
  expect(templates.map((item) => item.name)).toEqual(
    expect.arrayContaining([
      "Morning project brief",
      "Weekly document review",
      "Watched-folder report",
      "Repository maintenance check",
      "Research digest",
    ]),
  )
  for (const item of templates) {
    const schedule = item.schedule.kind === "cron" ? { ...item.schedule, tz: "America/Toronto" } : item.schedule
    const preview = await app.request("/kilocode/agent-forecast", {
      method: "POST",
      headers,
      body: JSON.stringify(schedule),
    })
    expect(preview.status).toBe(200)
    const result = Schema.decodeUnknownSync(RayaTask.Forecast)(await preview.json())
    expect(result.schedule).toEqual(schedule)
    expect(result.occurrences).toHaveLength(schedule.kind === "cron" ? 3 : 0)
  }
  const folder = templates.find((item) => item.id === "folder-report")
  expect(folder?.schedule).toEqual({ kind: "manual" })
  expect(folder?.objective).toContain("configure a supported trigger separately")
  expect(await (await app.request("/kilocode/agent", { headers })).json()).toEqual(before)
}, 30_000)

test("legacy access review is required before startup and saves only against the reviewed access", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Legacy access",
      objective: "Work",
      role: "coder",
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  await AppRuntime.runPromise(
    Storage.Service.use((storage) =>
      Effect.gen(function* () {
        const rows = yield* storage.read<RayaTask.Agent[]>(["raya", "agent"])
        yield* storage.replace(
          ["raya", "agent"],
          rows.map((item) => {
            if (item.id !== agent.id) return item
            const legacy = { ...item }
            delete legacy.access
            return legacy
          }),
        )
      }),
    ),
  )
  const url = `/kilocode/agent/${agent.id}`
  const refused = await app.request(`${url}/run`, { method: "POST", headers })
  expect(refused.status).toBe(400)
  expect(await refused.text()).toContain("workspace access")
  const reviewed = await app.request(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ access: "full", expectedAccess: "unset" }),
  })
  expect(reviewed.status).toBe(200)
  expect(await reviewed.json()).toMatchObject({ access: "full", enabled: false, schedule: { kind: "manual" } })
  const stale = await app.request(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ access: "brief", expectedAccess: "unset" }),
  })
  expect(stale.status).toBe(400)
  expect(await stale.text()).toContain("access changed")
  const changed = await app.request(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ access: "brief", expectedAccess: "full" }),
  })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ access: "brief", enabled: false })
  expect(await (await app.request(`${url}/runs`, { headers })).json()).toEqual([])
}, 30_000)

test("routine removal returns a useful conflict and preserves completed history", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Remove", objective: "Work", schedule: { kind: "manual" } }),
  })
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  expect(await (await app.request("/kilocode/agent-archive", { headers })).json()).toEqual({ items: [] })
  const run = await AppRuntime.runPromise(
    Storage.Service.use((storage) =>
      RayaTask.make({ storage }).record({
        id: "remove-http",
        agentID: agent.id,
        at: Date.now(),
        sessionID: SessionID.make("ses_remove_http"),
        status: "running",
      }),
    ),
  )
  const url = `/kilocode/agent/${agent.id}`
  const denied = await app.request(url, { method: "DELETE", headers })
  expect(denied.status).toBe(400)
  expect(await denied.text()).toContain("unfinished runs")
  await AppRuntime.runPromise(
    Storage.Service.use((storage) => RayaTask.make({ storage }).transition(run, { ...run, status: "complete" })),
  )
  expect((await app.request(url, { method: "DELETE", headers })).status).toBe(200)
  const response = await app.request("/kilocode/agent-archive", { headers })
  expect(response.status).toBe(200)
  const archive = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.ArchivePage))(await response.json()).items
  expect(archive).toHaveLength(1)
  expect(archive[0].definition).toEqual(agent)
  expect(archive[0].archivedAt).toBeGreaterThanOrEqual(agent.createdAt)
  const history = await app.request(`${url}/runs`, { headers })
  expect(history.status).toBe(200)
  const saved = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Run)))(await history.json())
  expect(saved[0]?.id).toBe(run.id)
  expect(saved[0]?.status).toBe("complete")
  expect((await app.request(url, { method: "DELETE", headers })).status).toBe(404)
}, 30_000)

test("startup snapshot HTTP reads preserve original instructions and reject missing or mismatched evidence", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Original", objective: "Original instructions", schedule: { kind: "manual" } }),
  })
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const saved = await AppRuntime.runPromise(
    Storage.Service.use((storage) =>
      RayaTaskSnapshot.make({ storage }).save({
        version: 1,
        runID: "snapshot-run",
        agentID: agent.id,
        at: 1234,
        definition: agent,
        objective: "Original resolved context",
      }),
    ),
  )
  const url = `/kilocode/agent/${agent.id}/runs/${saved.runID}/snapshot`
  const update = await app.request(`/kilocode/agent/${agent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ objective: "Edited instructions" }),
  })
  expect(update.status).toBe(200)
  const response = await app.request(url, { headers })
  expect(response.status).toBe(200)
  const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTaskSnapshot.Info))(await response.json())
  expect(snapshot.objective).toBe("Original resolved context")
  expect(snapshot.definition.objective).toBe("Original instructions")
  const history = await app.request(`/kilocode/agent/${agent.id}/runs`, { headers })
  expect(await history.json()).toEqual([])
  const missing = await app.request(`/kilocode/agent/${agent.id}/runs/legacy-run/snapshot`, { headers })
  expect(missing.status).toBe(404)
  const other = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Other", objective: "Other work", schedule: { kind: "manual" } }),
  })
  const unrelated = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await other.json())
  const wrong = await app.request(`/kilocode/agent/${unrelated.id}/runs/${saved.runID}/snapshot`, { headers })
  expect(wrong.status).toBe(404)
  expect(await wrong.text()).not.toContain("Original resolved context")
  expect((await app.request(`/kilocode/agent/${agent.id}`, { method: "DELETE", headers })).status).toBe(200)
  const retained = await app.request(url, { headers })
  expect(retained.status).toBe(200)
  expect(await retained.json()).toEqual(snapshot)
  const archived = await app.request("/kilocode/agent-archive", { headers })
  const definitions = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.ArchivePage))(await archived.json()).items
  expect(definitions.find((item) => item.definition.id === agent.id)?.definition.objective).toBe("Edited instructions")
  const roster = await app.request("/kilocode/agent", { headers })
  const listed = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Agent)))(await roster.json())
  expect(listed.some((item) => item.id === agent.id)).toBe(false)
  const mismatched = await app.request(`/kilocode/agent/not-a-routine/runs/${saved.runID}/snapshot`, { headers })
  expect(mismatched.status).toBe(404)
  expect(await mismatched.text()).not.toContain("Original resolved context")
  expect((await app.request(`/kilocode/agent/${agent.id}/runs/legacy-run/snapshot`, { headers })).status).toBe(404)
  const key = ["raya", "agent-starts", createHash("sha256").update(saved.runID).digest("hex")]
  await AppRuntime.runPromise(Storage.Service.use((storage) => storage.replace(key, { ...saved, runID: "mismatched" })))
  const invalid = await app.request(url, { headers })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ message: "Routine snapshot identity mismatch." })
  await AppRuntime.runPromise(Storage.Service.use((storage) => storage.replace(key, { version: 1 })))
  const corrupt = await app.request(url, { headers })
  expect(corrupt.status).toBe(400)
  expect(await corrupt.json()).toMatchObject({ message: "The saved startup snapshot is invalid." })
}, 30_000)

test("routine schedule HTTP updates reject a concurrent stale editor", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Scheduled review", objective: "Review changes", schedule: { kind: "manual" } }),
  })
  expect(created.status).toBe(200)
  const initial = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const trigger = { kind: "timer" as const, id: "occurrence", scheduledAt: 1000, observedAt: 2000, tz: "UTC" }
  await AppRuntime.runPromise(
    Storage.Service.use((storage) =>
      RayaTask.make({ storage }).record({
        id: "history",
        agentID: initial.id,
        sessionID: SessionID.make("ses_history"),
        at: 3000,
        status: "complete",
        trigger,
      }),
    ),
  )
  const history = await app.request(`/kilocode/agent/${initial.id}/runs`, { headers })
  expect(history.status).toBe(200)
  const runs = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Run)))(await history.json())
  expect(runs[0]?.trigger).toEqual(trigger)
  expect(runs[0]?.at).toBe(3000)
  const schedules = [
    { kind: "cron", expr: "0 9 * * 1", tz: "UTC" },
    { kind: "cron", expr: "0 9 * * 5", tz: "UTC" },
  ]
  const responses = await Promise.all(
    schedules.map(async (schedule) =>
      app.request(`/kilocode/agent/${initial.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ schedule, expectedSchedule: initial.schedule }),
      }),
    ),
  )
  expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 400])
  const rejected = responses.find((response) => response.status === 400)
  expect(await rejected?.json()).toMatchObject({ message: expect.stringContaining("schedule changed") })
  const accepted = responses.find((response) => response.status === 200)
  const winner = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await accepted?.json())
  expect(winner.scheduleVersion).toBe(2)
  const listed = await app.request("/kilocode/agent", { headers })
  const items = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Agent)))(await listed.json())
  expect(items.find((item) => item.id === initial.id)?.schedule).toEqual(winner.schedule)
  const restored = await app.request(`/kilocode/agent/${initial.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ schedule: initial.schedule, expectedScheduleVersion: winner.scheduleVersion }),
  })
  expect(restored.status).toBe(200)
  const stale = await app.request(`/kilocode/agent/${initial.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      schedule: winner.schedule,
      expectedSchedule: initial.schedule,
      expectedScheduleVersion: initial.scheduleVersion,
    }),
  })
  expect(stale.status).toBe(400)
  expect(await stale.json()).toMatchObject({ message: expect.stringContaining("version changed") })
  await AppRuntime.runPromise(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        const now = Date.now()
        yield* queue.publish({ agentID: initial.id, version: 1, occurrences: [{ at: now, observedAt: now }] })
        const row = (yield* queue.pending(initial.id, 1))[0]
        if (!row) throw new Error("Expected queued work")
        yield* queue.claim({ id: row.id, claimID: "recovery", owner: "another-backend", now, until: now + 180_000 })
        yield* queue.link({ id: row.id, claimID: "recovery", sessionID: "ses_recovery", now })
      }),
    ),
  )
  const recovery = await app.request("/kilocode/agent", { headers })
  expect(recovery.status).toBe(200)
  const recovered = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Agent)))(
    await recovery.json(),
  ).find((item) => item.id === initial.id)
  expect(recovered?.execution).toEqual({
    state: "recovery",
    sessionID: SessionID.make("ses_recovery"),
    runID: "recovery",
  })
  expect(recovered?.nextRun).toBeUndefined()
}, 30_000)

test("schedule forecast HTTP route returns occurrences without adding a routine", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const before = await app.request("/kilocode/agent", { headers })
  expect(before.status).toBe(200)
  const roster = await before.json()
  const response = await app.request("/kilocode/agent-forecast", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "cron", expr: "0 9 * * 1", tz: "America/Toronto" }),
  })
  expect(response.status).toBe(200)
  const result = Schema.decodeUnknownSync(RayaTask.Forecast)(await response.json())
  expect(result.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1", tz: "America/Toronto" })
  expect(result.occurrences).toHaveLength(3)
  expect(result.occurrences.every((at) => at > result.from)).toBe(true)
  const local = await app.request("/kilocode/agent-forecast", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "local", local: "2090-01-10T09:00:12.345", tz: "America/Toronto" }),
  })
  expect(local.status).toBe(200)
  const resolved = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Forecast))(await local.json())
  expect(resolved.schedule).toEqual({ kind: "once", at: Date.parse("2090-01-10T14:00:12.345Z") })
  expect(resolved.timezone).toBe("America/Toronto")
  const gap = await app.request("/kilocode/agent-forecast", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "local", local: "2027-03-14T02:30", tz: "America/Toronto" }),
  })
  expect(gap.status).toBe(400)
  expect(await gap.json()).toMatchObject({
    message: expect.stringContaining("does not exist"),
    kind: "schedule",
    field: "schedule",
  })
  const after = await app.request("/kilocode/agent", { headers })
  expect(await after.json()).toEqual(roster)
  const invalid = await app.request("/kilocode/agent-forecast", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "cron", expr: "0 9 * * *", tz: "Invalid/Zone" }),
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({
    message: "Use a valid timezone for this routine.",
    kind: "schedule",
    field: "timezone",
  })
}, 30_000)

test("archive pages stay bounded and anchored when newer removals arrive", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Active", objective: "Work", schedule: { kind: "manual" } }),
  })
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const records = Array.from({ length: 52 }, (_, index) => ({
    version: 1,
    archivedAt: 1000,
    definition: { ...agent, id: `archived-${String(index).padStart(2, "0")}` },
  }))
  const staged = { version: 1, archivedAt: 2000, definition: agent }
  // Earlier HTTP reads initialize the shared in-memory store; exercise a fresh legacy import here.
  expect(Database.path()).toBe(":memory:")
  await AppRuntime.runPromise(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        yield* database.db.delete(RayaRoutineArchiveTable).run()
        yield* database.db.delete(RayaRoutineArchiveImportTable).run()
      }),
    ),
  )
  await AppRuntime.runPromise(
    Storage.Service.use((storage) => storage.replace(["raya", "agent-archive"], [staged, ...records])),
  )
  const read = async (query = "") => {
    const response = await app.request(`/kilocode/agent-archive${query}`, { headers })
    expect(response.status).toBe(200)
    return Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.ArchivePage))(await response.json())
  }
  const first = await read()
  expect(first.items).toHaveLength(50)
  expect(first.items[0].definition.id).toBe("archived-00")
  expect(first.next).toBe("archived-49")
  const response = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Newer removal", objective: "Work", schedule: { kind: "manual" } }),
  })
  const newer = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await response.json())
  expect((await app.request(`/kilocode/agent/${newer.id}`, { method: "DELETE", headers })).status).toBe(200)
  const second = await read(`?cursor=${first.next}`)
  expect(second.items.map((item) => item.definition.id)).toEqual(["archived-50", "archived-51"])
  expect(second.next).toBeUndefined()
  expect((await read()).items[0].definition.id).toBe(newer.id)
  expect((await read("?agentID=archived-51")).items.map((item) => item.definition.id)).toEqual(["archived-51"])
  expect((await read(`?agentID=${agent.id}`)).items).toEqual([])
  for (const query of ["?cursor=missing", "?cursor=", "?cursor=archived-49&agentID=archived-51"])
    expect((await app.request(`/kilocode/agent-archive${query}`, { headers })).status).toBe(400)
}, 30_000)
