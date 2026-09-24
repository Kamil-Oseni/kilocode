import { describe, expect, test } from "bun:test"
import { validate } from "../../src/kilocode/task/assignment-proposal"
import type { Organization } from "../../src/kilocode/task/organization"

const organization = {
  version: 1,
  id: "org_00000000000000000000000000000001",
  name: "Acceptance Team",
  revision: 1,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  members: [
    { agentID: "lead", role: "Coordinator", position: 0 },
    { agentID: "writer", role: "Writer", position: 1 },
  ],
  delegations: [{ senderID: "lead", recipientID: "writer", position: 0 }],
} as Organization

const workers = [
  { id: "lead", name: "Lead", role: "Coordinator", objective: "Coordinate reports", enabled: true },
  { id: "writer", name: "Writer", role: "Writer", objective: "Write reports", enabled: true },
  { id: "stranger", name: "Stranger", role: "Writer", objective: "Write reports", enabled: true },
]

describe("organization assignment proposal", () => {
  test("keeps only exact authorized active routes and bounded useful work", () => {
    const draft = {
      senderID: "lead",
      recipientID: "writer",
      objective: " Write a report ",
      expected: " A reviewed report ",
      context: " Use the saved records ",
    }
    expect(validate(draft, organization, workers)).toEqual({
      senderID: "lead",
      recipientID: "writer",
      objective: "Write a report",
      expected: "A reviewed report",
      context: "Use the saved records",
    })
    expect(validate({ ...draft, recipientID: "stranger" }, organization, workers)).toBeUndefined()
    expect(validate({ ...draft, senderID: "writer", recipientID: "lead" }, organization, workers)).toBeUndefined()
    expect(
      validate(
        draft,
        organization,
        workers.map((worker) => (worker.id === "writer" ? { ...worker, enabled: false } : worker)),
      ),
    ).toBeUndefined()
    expect(validate({ ...draft, expected: "" }, organization, workers)).toBeUndefined()
    expect(validate({ ...draft, objective: "x".repeat(8001) }, organization, workers)).toBeUndefined()
    expect(validate(draft, { ...organization, members: organization.members.slice(0, 1) }, workers)).toBeUndefined()
  })
})
