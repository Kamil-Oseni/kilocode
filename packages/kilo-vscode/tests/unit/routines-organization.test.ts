import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

const id = `org_${"a".repeat(32)}`
const worker = "11111111-1111-4111-8111-111111111111"
const peer = "22222222-2222-4222-8222-222222222222"
const saved = {
  version: 1 as const,
  id,
  name: "Finance",
  purpose: "Review the books",
  revision: 4,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  members: [
    { agentID: worker, role: "Lead", position: 0 },
    { agentID: peer, role: "Reviewer", supervisorID: worker, position: 1 },
  ],
  delegations: [{ senderID: worker, recipientID: peer, position: 0 }],
}

test("organization update sends the full explicit graph and verifies the response", async () => {
  const calls: Request[] = []
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json(saved)
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineOrganizationUpdate",
      requestID: "request",
      organizationID: id,
      expectedRevision: 3,
      name: " Finance ",
      purpose: " Review the books ",
      members: [
        { agentID: worker, role: " Lead " },
        { agentID: peer, role: "Reviewer", supervisorID: worker },
      ],
      delegations: [{ senderID: worker, recipientID: peer }],
    },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).pathname).toBe(`/kilocode/organization/${id}`)
  expect(await calls[0].json()).toEqual({
    expectedRevision: 3,
    name: "Finance",
    purpose: "Review the books",
    members: [
      { agentID: worker, role: "Lead" },
      { agentID: peer, role: "Reviewer", supervisorID: worker },
    ],
    delegations: [{ senderID: worker, recipientID: peer }],
  })
  expect(messages).toEqual([
    { type: "routineOrganizationUpdated", requestID: "request", organizationID: id, organization: saved },
  ])
})

test("organization update rejects malformed trusted-boundary responses", async () => {
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () => Response.json({ ...saved, revision: "4" }),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineOrganizationUpdate",
      requestID: "request",
      organizationID: id,
      expectedRevision: 3,
      name: "Finance",
      purpose: "",
      members: [{ agentID: worker, role: "Lead" }],
      delegations: [],
    },
  })
  expect(messages).toHaveLength(1)
  expect(messages[0].type).toBe("routineOrganizationUpdated")
  expect(messages[0].organization).toBeUndefined()
  expect(messages[0].error).toContain("could not be verified")
})

test("organization archive includes the expected revision and returns a bounded receipt", async () => {
  const calls: Request[] = []
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({ ...saved, revision: 5, archived: true, archivedAt: 3 })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineOrganizationArchive",
      requestID: "request",
      organizationID: id,
      expectedRevision: 4,
    },
  })
  expect(calls[0].method).toBe("DELETE")
  expect(await calls[0].json()).toEqual({ expectedRevision: 4 })
  expect(messages).toEqual([
    { type: "routineOrganizationArchived", requestID: "request", organizationID: id, revision: 5 },
  ])
})
