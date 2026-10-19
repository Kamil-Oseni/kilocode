import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { payload } from "@/kilocode/migration/profile-bundle"
import { inactive } from "@/kilocode/migration/profile-safety"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { Codec as Task } from "@/kilocode/task/schema"
import { Receipt } from "@/kilocode/goal/stop-receipt"
import { goalStop } from "@/kilocode/migration/profile-goal-stop-correspondence"
import { createHash } from "node:crypto"

test("inactive profile restore rebuilds derived routine history while retaining remapped canonical reports", () => {
  const root = path.join(os.tmpdir(), "raya-routine-source")
  const target = path.join(os.tmpdir(), "raya-routine-target")
  const card = Schema.decodeUnknownSync(RayaRoutineReports.Card)({
    version: 1,
    id: "occurrence-one",
    runID: "run-one",
    agentID: "agent-one",
    name: "Daily brief",
    reportSessionID: "ses_report",
    projectID: "project-one",
    directory: root,
    revision: 2,
    runRevision: 1,
    status: "complete",
    at: 100,
    summary: "The brief is complete.",
    delivery: "delivered",
    notice: { at: 90, reason: "busy" },
  })
  const source = payload.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: 100,
    schema: "a".repeat(64),
    workspaces: [root],
    sql: [],
    json: [
      { path: "raya/routine-reports/canonical.json", value: JSON.stringify(card) },
      { path: "raya/routine-report-index/session.json", value: JSON.stringify({ stale: true }) },
    ],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
  const destination = inactive(source, 200, new Map([[root, target]]))
  expect(destination.json.map((item) => item.path)).toEqual(["raya/routine-reports/canonical.json"])
  expect(JSON.parse(destination.json[0].value)).toEqual({ ...card, directory: target, delivery: "unavailable" })
  expect(source.json).toHaveLength(2)
  expect(JSON.parse(source.json[0].value)).toEqual(card)
})

test("inactive same-PC restore retains exact stopped history and receipts without importing execution authority", () => {
  const root = path.join(os.tmpdir(), "raya-stopped-source")
  const target = path.join(os.tmpdir(), "raya-stopped-restored")
  const agent = Schema.decodeUnknownSync(Task.Agent)({
    id: "worker-original",
    name: "Stopped café 日本語",
    role: "generalist",
    objective: "Retain the original outcome",
    capabilities: ["computer"],
    memoryScope: "session",
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    scheduleVersion: 2,
    enabled: true,
    createdAt: 1,
    updatedAt: 100,
    dir: root,
    access: "full",
    tools: ["read", "bash"],
    paths: { version: 1, grants: [{ path: root, access: "write" }] },
    provisioning: { enabled: true, source: "user", changedAt: 100 },
  })
  const stop = { version: 1 as const, intent: "original-stop-intent", at: 120 }
  const trigger = { kind: "timer" as const, id: "original-occurrence", scheduledAt: 100, observedAt: 101, tz: "UTC" }
  const stopped = Schema.decodeUnknownSync(Task.Run)({
    id: "stopped-original",
    agentID: agent.id,
    sessionID: "ses_original",
    at: 101,
    goalCreatedAt: 102,
    scheduleVersion: 2,
    trigger,
    revision: 3,
    status: "stopped",
    stop,
    outcome: { kind: "notify", summary: "Stopped by the user. No unverified result was accepted.", cost: 0 },
  })
  const identity = { version: 2, agentID: agent.id, runID: stopped.id, scheduleVersion: 2, trigger }
  const digest = (text: string) => createHash("sha256").update(text).digest("hex")
  const receipt = Schema.decodeUnknownSync(Receipt)({
    sessionID: stopped.sessionID,
    intent: stop.intent,
    at: 110,
    phase: "finished",
    interrupted: true,
    finishedAt: 130,
    task: {
      version: 1,
      stop,
      sessionDigest: digest(JSON.stringify(identity)),
      runs: [
        {
          id: stopped.id,
          agentID: agent.id,
          sessionID: stopped.sessionID,
          at: stopped.at,
          scheduleVersion: 2,
          trigger,
          executionDigest: "e".repeat(64),
        },
      ],
    },
  })
  const history = Schema.decodeUnknownSync(Task.History)({
    version: 1,
    cursor: 1,
    runs: [
      stopped,
      ...(["complete", "error", "running", "blocked"] as const).map((status) => ({
        id: `other-${status}`,
        agentID: agent.id,
        sessionID: `ses_${status}`,
        at: 10,
        scheduleVersion: 2,
        status,
      })),
    ],
    events: [
      {
        version: 1,
        id: "original-event",
        stream: "original-device",
        sequence: 1,
        kind: "run.changed",
        visibility: "workspace",
        runID: stopped.id,
        agentID: agent.id,
        sessionID: stopped.sessionID,
        stateRevision: 3,
        status: "stopped",
        at: 130,
      },
    ],
  })
  const card = Schema.decodeUnknownSync(RayaRoutineReports.Card)({
    version: 1,
    id: trigger.id,
    runID: stopped.id,
    agentID: agent.id,
    name: agent.name,
    reportSessionID: "ses_reports",
    workerSessionID: stopped.sessionID,
    projectID: "project-original",
    directory: root,
    revision: 2,
    runRevision: 3,
    status: "stopped",
    at: stopped.at,
    summary: stopped.outcome!.summary,
    delivery: "delivered",
  })
  const file = `raya/goal-stops/${stopped.sessionID}/${digest(stop.intent)}.json`
  const runs = `raya/agent-runs/${agent.id}.json`
  const owner = {
    version: 1,
    agentID: agent.id,
    runID: stopped.id,
    sessionID: stopped.sessionID,
    token: crypto.randomUUID(),
    owner: { host: "source-device", pid: 123, birth: "original-birth" },
    state: "idle",
    createdAt: 103,
    updatedAt: 129,
  }
  const source = payload.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: 140,
    schema: "a".repeat(64),
    workspaces: [root],
    sql: [
      {
        table: "session",
        columns: ["id", "metadata"],
        rows: [[stopped.sessionID, JSON.stringify({ rayaRoutine: identity })]],
      },
      {
        table: "raya_routine_occurrence",
        columns: ["id", "state", "claim_id", "lease_owner", "lease_until"],
        rows: [
          [trigger.id, "cancelled", stopped.id, "source-owner", 150],
          ["unfinished-occurrence", "active", "unfinished-run", "source-owner", 150],
        ],
      },
      { table: "session_input", columns: ["id"], rows: [["source-pending-input"]] },
      { table: "raya_routine_cursor", columns: ["id"], rows: [["source-cursor"]] },
    ],
    json: [
      { path: "raya/agent.json", value: JSON.stringify([agent]) },
      { path: runs, value: JSON.stringify(history) },
      { path: file, value: JSON.stringify(receipt) },
      { path: `raya/routine-reports/${digest(card.id)}.json`, value: JSON.stringify(card) },
      { path: `raya/agent-executions/${digest(stopped.id)}.json`, value: JSON.stringify(owner) },
      {
        path: `raya/agent-execution-reviews/${digest(stopped.id)}/${digest(owner.token)}.json`,
        value: JSON.stringify({ version: 1, actor: "user", at: 130, record: owner }),
      },
      { path: "raya/scheduler-owners/original.json", value: JSON.stringify({ owner: "source-only" }) },
      { path: "raya/routine-report-index/source.json", value: JSON.stringify({ sourceOnly: true }) },
    ],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
  const original = JSON.stringify(source)
  expect(goalStop(file, JSON.stringify(receipt), source)).toBe(true)
  const destination = inactive(source, 200, new Map([[root, target]]))
  const read = (data: typeof source, name: string): unknown => {
    const item = data.json.find((item) => item.path === name)
    if (!item) throw new Error(`Missing retained profile record: ${name}`)
    return JSON.parse(item.value)
  }
  const retained = Schema.decodeUnknownSync(Task.History)(read(destination, runs))
  expect(retained.runs.find((run) => run.id === stopped.id)).toEqual(stopped)
  expect(retained.runs.map((run) => run.status)).toEqual(["stopped", "complete", "error"])
  expect(retained.events).toEqual([])
  expect(retained.cursor).toBe(0)
  expect(read(destination, file)).toEqual(receipt)
  expect(goalStop(file, JSON.stringify(receipt), destination)).toBe(true)
  expect(read(destination, `raya/routine-reports/${digest(card.id)}.json`)).toEqual({
    ...card,
    directory: target,
    delivery: "unavailable",
  })
  expect(read(destination, "raya/agent.json")).toEqual(
    [
      {
        ...agent,
        enabled: false,
        dir: target,
        access: "brief",
        tools: [],
        paths: undefined,
        updatedAt: 200,
        scheduleUpdatedAt: 200,
        scheduleVersion: 3,
        provisioning: { ...agent.provisioning, enabled: false, changedAt: 200 },
      },
    ].map((agent) => JSON.parse(JSON.stringify(agent))),
  )
  expect(
    destination.json.some((item) =>
      /raya\/(?:agent-executions|agent-execution-reviews|scheduler-owners|routine-report-index)\//.test(item.path),
    ),
  ).toBe(false)
  expect(destination.sql.find((table) => table.table === "raya_routine_occurrence")?.rows).toEqual([
    [trigger.id, "cancelled", null, null, null],
  ])
  expect(destination.sql.find((table) => table.table === "session_input")?.rows).toEqual([])
  expect(destination.sql.find((table) => table.table === "raya_routine_cursor")?.rows).toEqual([])
  // A repeated inactive projection is not a runtime/cold-process acceptance claim.
  const again = inactive(destination, 300, new Map([[target, target]]))
  expect(Schema.decodeUnknownSync(Task.History)(read(again, runs))).toEqual(retained)
  expect(read(again, file)).toEqual(receipt)
  expect(goalStop(file, JSON.stringify(receipt), again)).toBe(true)
  expect(JSON.stringify(source)).toBe(original)
})
