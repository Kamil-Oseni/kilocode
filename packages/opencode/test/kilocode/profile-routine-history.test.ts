import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { payload } from "@/kilocode/migration/profile-bundle"
import { inactive } from "@/kilocode/migration/profile-safety"
import { RayaRoutineReports } from "@/kilocode/task/projection"

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
