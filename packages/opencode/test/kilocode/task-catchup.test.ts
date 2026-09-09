import { expect, test } from "bun:test"
import { RayaTask } from "@/kilocode/task"
import { SessionID } from "@/session/schema"

const at = Date.parse("2030-01-02T09:00:00Z")
function routine(schedule: RayaTask.Schedule): RayaTask.Agent {
  return {
    id: "catchup",
    name: "Catch-up policy",
    role: "briefer",
    objective: "Report the result",
    capabilities: [],
    memoryScope: "role",
    schedule,
    enabled: true,
    createdAt: at - 86_400_000,
    updatedAt: at - 86_400_000,
  }
}

test("unselected recurring occurrences have a strict one-minute catch-up window", () => {
  const item = routine({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })
  expect(RayaTask.due(item, at)).toBe(at)
  expect(RayaTask.due(item, at + 59_999)).toBe(at)
  expect(RayaTask.due(item, at + 60_000)).toBeUndefined()
  expect(RayaTask.next(item, at + 60_000)).toBe(at + 86_400_000)
  expect(RayaTask.due(item, at + 4 * 86_400_000 + 30_000)).toBe(at + 4 * 86_400_000)
  expect(RayaTask.due(item, at + 4 * 86_400_000 + 60_000)).toBeUndefined()
})

test("catch-up uses the stored local timezone and does not create a backlog", () => {
  const item = routine({ kind: "cron", expr: "0 9 * * *", tz: "America/New_York" })
  const local = Date.parse("2030-01-02T14:00:00Z")
  expect(RayaTask.due(item, local + 30_000)).toBe(local)
  expect(RayaTask.due(item, local + 60_000)).toBeUndefined()
  expect(RayaTask.next(item, local + 60_000)).toBe(local + 86_400_000)
})

test("overdue one-time work stays due until its recorded occurrence is consumed", () => {
  const item = routine({ kind: "once", at })
  const later = at + 7 * 86_400_000
  expect(RayaTask.due(item, later)).toBe(at)
  expect(
    RayaTask.due(item, later, {
      id: "completed",
      agentID: item.id,
      sessionID: SessionID.make("ses_catchup"),
      at: later,
      status: "complete",
      trigger: { kind: "timer", id: "selected", scheduledAt: at, observedAt: later },
    }),
  ).toBeUndefined()
  expect(RayaTask.due({ ...item, enabled: false }, later)).toBeUndefined()
})
