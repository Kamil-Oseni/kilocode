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

const agent = {
  id: worker,
  name: "Finance lead",
  role: "accountant",
  objective: "Review the books",
  capabilities: ["accounting", "organization:provision"],
  provisioning: { enabled: true, source: "user" as const, changedAt: 3 },
  memoryScope: "role" as const,
  schedule: { kind: "manual" as const },
  enabled: true,
  createdAt: 1,
  updatedAt: 3,
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

test("worker creation authority sends the expected state and verifies durable provenance", async () => {
  const calls: Request[] = []
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json(agent)
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineProvisioningUpdate",
      requestID: "request",
      agentID: worker,
      enabled: true,
      expected: false,
    },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).pathname).toBe(`/kilocode/agent/${worker}/provisioning`)
  expect(await calls[0].json()).toEqual({ enabled: true, expected: false })
  expect(messages).toEqual([{ type: "routineProvisioningUpdated", requestID: "request", agentID: worker, agent }])
})

test("worker creation authority rejects a response without matching provenance", async () => {
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () => Response.json({ ...agent, provisioning: undefined }),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineProvisioningUpdate",
      requestID: "request",
      agentID: worker,
      enabled: true,
      expected: false,
    },
  })
  expect(messages).toHaveLength(1)
  expect(messages[0].type).toBe("routineProvisioningUpdated")
  expect(messages[0].agent).toBeUndefined()
  expect(messages[0].error).toContain("could not be verified")
})
