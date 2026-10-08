import { expect, test } from "bun:test"
import path from "node:path"
import { valid } from "../../src/kilocode/second-brain/reply"
import { RequestID, type Request, type StatusResult } from "../../src/kilocode/second-brain/protocol"
import { SessionID } from "../../src/session/schema"

test("capture status validates capacity reasons and cannot report unconfigured readiness", () => {
  const project = path.resolve("status-project")
  const request: Request = {
    id: RequestID.make("capture-status"),
    sessionID: SessionID.make("ses_capture_status"),
    project,
    command: { action: "status" },
  }
  const result: typeof StatusResult.Type = {
    action: "status",
    project,
    configured: true,
    root: path.join(project, "SecondBrain"),
    index: "synced",
    capture: "ready",
    preparation: "unavailable",
  }
  expect(valid(request, result)).toBe(true)
  expect(valid(request, { ...result, capture: "saving" })).toBe(true)
  expect(valid(request, { ...result, capture: "uncertain" })).toBe(true)
  expect(valid(request, { ...result, capture: "capacity" })).toBe(false)
  expect(valid(request, { ...result, capture: "capacity", capture_reason: "source_capacity" })).toBe(true)
  expect(valid(request, { ...result, capture_reason: "ledger_capacity" })).toBe(false)
  expect(valid(request, { ...result, configured: false, root: undefined, index: "unchecked" })).toBe(false)
  expect(
    valid(request, { ...result, configured: false, root: undefined, index: "unchecked", capture: "unavailable" }),
  ).toBe(true)
})
