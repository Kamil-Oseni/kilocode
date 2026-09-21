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
  policy: "Require cited ledger evidence before approval.",
  budget: 500,
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
      policy: " Require cited ledger evidence before approval. ",
      budget: "500",
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
    policy: "Require cited ledger evidence before approval.",
    budget: 500,
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

test("organization update clears empty optional text explicitly", async () => {
  const calls: Request[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({ ...saved, policy: undefined })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: () => undefined,
    message: {
      type: "routineOrganizationUpdate",
      requestID: "clear_policy",
      organizationID: id,
      expectedRevision: 4,
      name: "Finance",
      purpose: "   ",
      policy: "   ",
      budget: "",
      members: [
        { agentID: worker, role: "Lead" },
        { agentID: peer, role: "Reviewer", supervisorID: worker },
      ],
      delegations: [{ senderID: worker, recipientID: peer }],
    },
  })
  expect(await calls[0].json()).toMatchObject({ purpose: "", policy: "", budget: 0 })
})

test("organization update rejects an invalid shared budget before dispatch", async () => {
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
      requestID: "invalid_budget",
      organizationID: id,
      expectedRevision: 4,
      name: "Finance",
      purpose: "",
      policy: "",
      budget: "12.5",
      members: [{ agentID: worker, role: "Lead" }],
      delegations: [],
    },
  })
  expect(calls).toHaveLength(0)
  expect(messages[0]?.error).toContain("whole-number organization budget")
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
      policy: "",
      budget: "",
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

test("organization activity stays scoped and preserves its cursor", async () => {
  const calls: Request[] = []
  const messages: Record<string, unknown>[] = []
  const item = {
    id: "work_1",
    sender: { id: worker, name: "Finance lead", role: "Lead", archived: false },
    recipient: { id: peer, name: "Reviewer", role: "Reviewer", archived: false },
    organizationID: id,
    source: "source_1",
    state: "completed",
    objective: "Review the books",
    time: 10,
    updated: 20,
    response: "The books balance.",
    artifacts: [
      {
        path: "C:/Projects/Finance/reports/friday-close.csv",
        sha256: "d".repeat(64),
        tool: "write",
        callID: "call_friday_close",
      },
    ],
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({
        items: [item],
        summary: {
          total: 8,
          active: 2,
          needsAttention: 1,
          uncertain: 1,
          recordedCost: 4.25,
          committedCost: 12,
          standaloneCost: 1.25,
          coordinatorCost: 0.75,
        },
        next: "next_page",
      })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineOrganizationActivity",
      requestID: "request",
      organizationID: id,
      cursor: "cursor_1",
    },
  })
  expect(calls).toHaveLength(1)
  const url = new URL(calls[0].url)
  expect(calls[0].method).toBe("GET")
  expect(url.pathname).toBe(`/kilocode/organization/${id}/activity`)
  expect(url.searchParams.get("directory")).toBe("workspace")
  expect(url.searchParams.get("cursor")).toBe("cursor_1")
  expect(messages).toEqual([
    {
      type: "routineOrganizationActivity",
      requestID: "request",
      organizationID: id,
      items: [item],
      summary: {
        total: 8,
        active: 2,
        needsAttention: 1,
        uncertain: 1,
        recordedCost: 4.25,
        committedCost: 12,
        standaloneCost: 1.25,
        coordinatorCost: 0.75,
      },
      next: "next_page",
    },
  ])
})

test("organization assignment forwards the authorized route and bounded work details", async () => {
  const calls: Request[] = []
  const messages: Record<string, unknown>[] = []
  const deadline = Date.now() + 60_000
  const record = {
    id: "work_2",
    source: "organization:finance:request",
    senderID: worker,
    recipientID: peer,
    organizationID: id,
    organizationName: "Finance",
    organizationRevision: 4,
    objective: "Prepare the September close package.",
    parentID: "work_1",
    parentRunID: "run_1",
    expected: "A reconciled close package.",
    context: "Use the approved finance workspace.",
    deadline,
    budget: 40,
    depth: 1,
    state: "running",
    time: 1,
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (new URL(request.url).pathname.endsWith("/delegate")) return Response.json(record)
      return Response.json([])
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineDelegate",
      requestID: "request",
      agentID: worker,
      recipientID: peer,
      source: record.source,
      organizationID: id,
      organizationRevision: 4,
      objective: " Prepare the September close package. ",
      parentID: "work_1",
      parentRunID: "run_1",
      expected: " A reconciled close package. ",
      context: " Use the approved finance workspace. ",
      deadline,
      budget: 40,
    },
  })
  expect(calls[0].method).toBe("POST")
  expect(await calls[0].json()).toEqual({
    source: record.source,
    senderID: worker,
    recipientID: peer,
    organizationID: id,
    organizationRevision: 4,
    objective: record.objective,
    parentID: "work_1",
    parentRunID: "run_1",
    expected: record.expected,
    context: record.context,
    deadline,
    budget: 40,
  })
  expect(messages[0]).toEqual({
    type: "routineDelegated",
    requestID: "request",
    agentID: worker,
    record,
  })
})

test("organization follow-on rejects a response attached to another parent", async () => {
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () =>
      Response.json({
        id: "work_2",
        source: "organization:finance:follow",
        senderID: worker,
        recipientID: peer,
        organizationID: id,
        organizationRevision: 4,
        objective: "Prepare the review deck.",
        parentID: "work_other",
        parentRunID: "run_1",
        state: "queued",
      }),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineDelegate",
      requestID: "request",
      agentID: worker,
      recipientID: peer,
      source: "organization:finance:follow",
      organizationID: id,
      organizationRevision: 4,
      objective: "Prepare the review deck.",
      parentID: "work_1",
      parentRunID: "run_1",
    },
  })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    type: "routineDelegated",
    requestID: "request",
    agentID: worker,
  })
  expect(messages[0].record).toBeUndefined()
  expect(messages[0].error).toContain("could not be verified")
})

test("organization assignment rejects a zero model-cost budget before dispatch", async () => {
  const messages: Record<string, unknown>[] = []
  let calls = 0
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () => {
      calls++
      return Response.json({})
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineDelegate",
      requestID: "zero-budget",
      agentID: worker,
      recipientID: peer,
      source: "organization:finance:zero-budget",
      organizationID: id,
      organizationRevision: 4,
      objective: "Prepare the close package.",
      budget: 0,
    },
  })
  expect(calls).toBe(0)
  expect(messages).toEqual([
    expect.objectContaining({
      type: "routineDelegated",
      requestID: "zero-budget",
      error: "Choose a whole-number budget from 1 to 1000000.",
    }),
  ])
})

test("organization assignment rejects a response from another organization", async () => {
  const messages: Record<string, unknown>[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () =>
      Response.json({
        id: "work_2",
        source: "organization:finance:request",
        senderID: worker,
        recipientID: peer,
        organizationID: `org_${"b".repeat(32)}`,
        organizationRevision: 4,
        objective: "Prepare the close package.",
        state: "running",
      }),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (message) => messages.push(message as Record<string, unknown>),
    message: {
      type: "routineDelegate",
      requestID: "request",
      agentID: worker,
      recipientID: peer,
      source: "organization:finance:request",
      organizationID: id,
      organizationRevision: 4,
      objective: "Prepare the close package.",
    },
  })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    type: "routineDelegated",
    requestID: "request",
    agentID: worker,
  })
  expect(messages[0].record).toBeUndefined()
  expect(messages[0].error).toContain("could not be verified")
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
