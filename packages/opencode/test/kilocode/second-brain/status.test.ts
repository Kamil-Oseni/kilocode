import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { RequestID, Status, StatusResult, type Request } from "@/kilocode/second-brain/protocol"
import { SessionID } from "@/session/schema"
import { valid } from "@/kilocode/second-brain/reply"

test("personal Memory status is request-bound and cannot claim capture or preparation readiness", () => {
  const project = path.resolve("status-project")
  const request: Request = {
    id: RequestID.make("fixture"),
    sessionID: SessionID.make("ses_fixture"),
    project,
    command: { action: "status" },
  }
  const value = {
    action: "status",
    project,
    configured: false,
    index: "unchecked",
    capture: "unavailable",
    preparation: "unavailable",
  } as const
  expect(Schema.is(Status)({ action: "status" })).toBe(true)
  expect(valid(request, value)).toBe(true)
  expect(valid(request, { ...value, project: path.resolve("other-project") })).toBe(false)
  expect(valid(request, { ...value, index: "synced" })).toBe(false)
  expect(valid(request, { ...value, configured: true })).toBe(false)
  expect(valid(request, { ...value, configured: true, root: path.resolve("notes"), index: "synced" })).toBe(true)
  expect(Schema.is(StatusResult)({ ...value, capture: "active" })).toBe(false)
  expect(Schema.is(StatusResult)({ ...value, preparation: "ready" })).toBe(false)
})
