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
import { RayaGoal } from "@/kilocode/goal"

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

test("inactive same-PC restore retains original failed final deliveries while dropping pending blocked work", () => {
  const root = path.join(os.tmpdir(), "raya-delivery-source")
  const target = path.join(os.tmpdir(), "raya-delivery-restored")
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const approved = "Approved literal output.\r\n"
  const contract = {
    kind: "file" as const,
    path: path.join(root, "approved.txt"),
    bytes: Buffer.byteLength(approved),
    sha256: digest(approved),
  }
  const agent = Schema.decodeUnknownSync(Task.Agent)({
    id: "delivery-worker",
    name: "Original delivery failures",
    role: "generalist",
    objective: "Return the approved file",
    output: {
      destination: "conversation",
      description: "The exact approved file",
      criteria: [{ id: "literal", description: "Preserve literal bytes", verification: "Compare the final output" }],
      final: contract,
    },
    capabilities: [],
    memoryScope: "session",
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    scheduleVersion: 2,
    enabled: true,
    createdAt: 1,
    updatedAt: 100,
    dir: root,
    access: "full",
    tools: ["read"],
    paths: { version: 1, grants: [{ path: root, access: "write" }] },
    provisioning: { enabled: true, source: "user", changedAt: 100 },
  })
  const failures = (["mismatch", "unavailable"] as const).map((status, index) => {
    const summary = status === "mismatch" ? `The file contains: ${approved}` : ""
    const id = `original-${status}`
    const sessionID = `ses_${status}`
    const messageID = `msg_${status}`
    const parentID = `msg_user_${status}`
    const intent = `intent-${status}`
    const dispatchID = `dispatch-${status}`
    const run = Schema.decodeUnknownSync(Task.Run)({
      id,
      agentID: agent.id,
      sessionID,
      at: 101 + index,
      goalCreatedAt: 110 + index,
      scheduleVersion: 2,
      trigger: {
        kind: "timer",
        id: `occurrence-${status}`,
        scheduledAt: 100 + index,
        observedAt: 101 + index,
        tz: "UTC",
      },
      revision: 3,
      status: "blocked",
      blockedReason: "The original final answer needs owner review; it was not retried.",
      outcome: {
        kind: "notify",
        summary,
        cost: 0,
        report: {
          version: 1,
          sessionID,
          messageID,
          parentID,
          at: 130 + index,
          partIDs: status === "mismatch" ? ["prt_original"] : [],
          dispatchID,
          goalCreatedAt: 110 + index,
          goalIntent: intent,
          sha256: digest(summary),
        },
        delivery: {
          version: 1,
          status,
          reason: status === "mismatch" ? "final-mismatch" : "final-missing",
          at: 140 + index,
          contract,
          ...(status === "mismatch"
            ? {
                source: {
                  messageID: "msg_read",
                  partID: "prt_read",
                  callID: "original-read",
                  path: contract.path,
                  canonical: contract.path,
                  bytes: contract.bytes,
                  sha256: contract.sha256,
                },
              }
            : {}),
          final: { messageID, bytes: Buffer.byteLength(summary), sha256: digest(summary) },
        },
      },
    })
    const goal = Schema.decodeUnknownSync(RayaGoal.State)({
      objective: agent.objective,
      status: "complete",
      intent,
      inputs: [parentID],
      createdAt: run.goalCreatedAt,
      updatedAt: 140 + index,
      routine: { agentID: agent.id, runID: id, sessionID },
      dispatch: {
        id: dispatchID,
        messageID: parentID,
        intent,
        phase: "finished",
        queuedAt: 111 + index,
        startedAt: 112 + index,
        finishedAt: 130 + index,
        assistantID: messageID,
        outcome: "completed",
      },
      usage: { turns: 1, continuations: 0, toolCalls: 1 },
      progress: [],
    })
    const card = Schema.decodeUnknownSync(RayaRoutineReports.Card)({
      version: 1,
      id: `occurrence-${status}`,
      runID: id,
      agentID: agent.id,
      name: agent.name,
      reportSessionID: "ses_reports",
      workerSessionID: sessionID,
      projectID: "original-project",
      directory: root,
      revision: 2,
      runRevision: run.revision,
      status: "blocked",
      at: run.at,
      summary,
      delivery: "delivered",
    })
    return { run, goal, card }
  })
  const history = Schema.decodeUnknownSync(Task.History)({
    version: 1,
    cursor: 1,
    runs: [
      ...failures.map((item) => item.run),
      { ...failures[0].run, id: "waiting-delivery", blockedReason: "waiting on you" },
      {
        id: "generic-blocked",
        agentID: agent.id,
        sessionID: "ses_generic",
        at: 10,
        status: "blocked",
        blockedReason: "Generic unmet work",
      },
      {
        id: "waiting",
        agentID: agent.id,
        sessionID: "ses_waiting",
        at: 10,
        status: "blocked",
        blockedReason: "waiting on you",
      },
      { id: "running", agentID: agent.id, sessionID: "ses_running", at: 10, status: "running" },
    ],
    events: [
      {
        version: 1,
        id: "source-event",
        stream: "source-device",
        sequence: 1,
        kind: "run.changed",
        visibility: "workspace",
        runID: failures[0].run.id,
        agentID: agent.id,
        sessionID: failures[0].run.sessionID,
        stateRevision: 3,
        status: "blocked",
        at: 150,
      },
    ],
  })
  const runs = `raya/agent-runs/${agent.id}.json`
  const source = payload.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: 160,
    schema: "a".repeat(64),
    workspaces: [root],
    sql: [
      {
        table: "raya_routine_occurrence",
        columns: ["id", "state", "claim_id", "lease_owner", "lease_until"],
        rows: [
          ...failures.map((item) => [item.card.id, "complete", item.run.id, "source-owner", 180]),
          ["pending", "active", "running", "source-owner", 180],
        ],
      },
      { table: "session_input", columns: ["id"], rows: [["pending-input"]] },
      { table: "raya_routine_cursor", columns: ["id"], rows: [["source-cursor"]] },
    ],
    json: [
      { path: "raya/agent.json", value: JSON.stringify([agent]) },
      { path: runs, value: JSON.stringify(history) },
      ...failures.flatMap((item) => [
        { path: `raya/goal/${item.run.sessionID}.json`, value: JSON.stringify(item.goal) },
        { path: `raya/routine-reports/${digest(item.card.id)}.json`, value: JSON.stringify(item.card) },
      ]),
      { path: "raya/agent-executions/original.json", value: JSON.stringify({ sourceOnly: true }) },
      { path: "raya/agent-starts/original.json", value: JSON.stringify({ definition: agent }) },
      { path: "raya/scheduler-owners/original.json", value: JSON.stringify({ sourceOnly: true }) },
      { path: "raya/routine-report-index/original.json", value: JSON.stringify({ sourceOnly: true }) },
    ],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
  const original = JSON.stringify(source)
  const read = (data: typeof source, file: string): unknown => {
    const row = data.json.find((row) => row.path === file)
    if (!row) throw new Error(`Missing retained record: ${file}`)
    return JSON.parse(row.value)
  }
  const destination = inactive(source, 200, new Map([[root, target]]))
  const retained = Schema.decodeUnknownSync(Task.History)(read(destination, runs))
  expect(retained.runs).toEqual(failures.map((item) => item.run))
  expect(retained.events).toEqual([])
  expect(retained.cursor).toBe(0)
  for (const item of failures) {
    expect(read(destination, `raya/goal/${item.run.sessionID}.json`)).toEqual({ ...item.goal, updatedAt: 200 })
    expect(read(destination, `raya/routine-reports/${digest(item.card.id)}.json`)).toEqual({
      ...item.card,
      directory: target,
      delivery: "unavailable",
    })
  }
  const roster = Schema.decodeUnknownSync(Schema.Array(Task.Agent))(read(destination, "raya/agent.json"))
  expect(roster[0]).toMatchObject({
    enabled: false,
    dir: target,
    access: "brief",
    tools: [],
    scheduleVersion: 3,
    provisioning: { enabled: false },
  })
  expect(roster[0].paths).toBeUndefined()
  expect(roster[0].output?.final).toEqual(contract)
  expect(
    destination.json.some((row) =>
      /raya\/(?:agent-executions|agent-starts|scheduler-owners|routine-report-index)\//.test(row.path),
    ),
  ).toBe(false)
  expect(destination.sql.find((table) => table.table === "raya_routine_occurrence")?.rows).toEqual(
    failures.map((item) => [item.card.id, "complete", null, null, null]),
  )
  expect(destination.sql.find((table) => table.table === "session_input")?.rows).toEqual([])
  expect(destination.sql.find((table) => table.table === "raya_routine_cursor")?.rows).toEqual([])
  const again = inactive(destination, 300, new Map([[target, target]]))
  expect(Schema.decodeUnknownSync(Task.History)(read(again, runs))).toEqual(retained)
  for (const item of failures)
    expect(read(again, `raya/routine-reports/${digest(item.card.id)}.json`)).toEqual(
      read(destination, `raya/routine-reports/${digest(item.card.id)}.json`),
    )
  expect(JSON.stringify(source)).toBe(original)
})
