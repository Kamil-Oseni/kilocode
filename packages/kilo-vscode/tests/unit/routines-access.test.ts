import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("access review sends only a conditional update and correlates confirmation and failures", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({ id: "routine", access: "brief", tools: ["read"] })
    },
  })
  const message = {
    type: "routineAccessUpdate",
    requestID: "review",
    agentID: "routine",
    access: "brief",
    tools: ["read"],
    paths: { version: 1 as const, grants: [] },
    expectedAccess: "unset",
    expectedTools: "unset",
    expectedPaths: "unset",
  }
  await handleRoutineMessage({ client, directory: "workspace", post: (msg) => messages.push(msg), message })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("workspace")
  expect(await calls[0].json()).toEqual({
    access: "brief",
    tools: ["read"],
    paths: { version: 1, grants: [] },
    expectedAccess: "unset",
    expectedTools: "unset",
    expectedPaths: "unset",
  })
  expect(messages[0]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    agentID: "routine",
    access: "brief",
    tools: ["read"],
    paths: undefined,
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, expectedAccess: undefined },
  })
  expect(calls).toHaveLength(1)
  expect(messages[1]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    error: "Reload the routine before reviewing access.",
    recovery: { kind: "access", field: "access", next: expect.stringContaining("workspace access") },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, expectedTools: undefined },
  })
  expect(calls).toHaveLength(1)
  expect(messages[2]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    error: "Reload the routine before reviewing access.",
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, expectedPaths: undefined },
  })
  expect(calls).toHaveLength(1)
  expect(messages[3]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    error: "Reload the routine before reviewing access.",
  })
  await handleRoutineMessage({ client: null, directory: "workspace", post: (msg) => messages.push(msg), message })
  expect(messages[4]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    error: "Raya is not connected.",
    recovery: { kind: "unavailable", next: expect.stringContaining("Reconnect") },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, access: "full", requestID: "mismatch" },
  })
  expect(messages[5]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "mismatch",
    error: "The saved access could not be confirmed. Reload the routine before trying again.",
  })
})

test("access review canonicalizes folders and rejects invalid access before transport", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({
        id: "routine",
        access: "full",
        tools: ["read"],
        paths: {
          version: 1,
          grants: [
            { path: "C:/Shared", access: "read" },
            { path: "c:/records", access: "write" },
          ],
        },
      })
    },
  })
  const message = {
    type: "routineAccessUpdate",
    requestID: "paths",
    agentID: "routine",
    access: "full",
    tools: ["read"],
    paths: {
      version: 1 as const,
      grants: [
        { path: "C:\\Records\\", access: "read" as const },
        { path: "c:/records", access: "write" as const },
        { path: "C:/Shared", access: "read" as const },
      ],
    },
    expectedAccess: "full" as const,
    expectedTools: ["read"],
    expectedPaths: "unset" as const,
  }
  await handleRoutineMessage({ client, directory: "workspace", post: (msg) => messages.push(msg), message })
  expect(calls).toHaveLength(1)
  expect(await calls[0].json()).toMatchObject({
    paths: {
      version: 1,
      grants: [
        { path: "C:/Shared", access: "read" },
        { path: "c:/records", access: "write" },
      ],
    },
  })
  expect(messages[0]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "paths",
    paths: {
      version: 1,
      grants: [
        { path: "C:/Shared", access: "read" },
        { path: "c:/records", access: "write" },
      ],
    },
  })

  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: {
      ...message,
      requestID: "relative",
      paths: { version: 1, grants: [{ path: "../private", access: "read" as const }] },
    },
  })
  expect(calls).toHaveLength(1)
  expect(messages[1]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "relative",
    error: "Reload the routine before reviewing access.",
  })
})

test("access review lists exact tools for each connected service", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({
        services: [{ name: "github", tools: ["github_create_issue", "github_read_issue"] }],
        truncated: false,
      })
    },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { type: "routineAuthorityServices", requestID: "catalog" },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("GET")
  expect(new URL(calls[0].url).pathname).toBe("/kilocode/agent-authority/services")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("workspace")
  expect(messages[0]).toEqual({
    type: "routineAuthorityServices",
    requestID: "catalog",
    services: [{ name: "github", tools: ["github_create_issue", "github_read_issue"] }],
    truncated: false,
  })
})

test("connected service review reports offline and malformed catalogs without accepting them", async () => {
  const messages: unknown[] = []
  const message = { type: "routineAuthorityServices", requestID: "catalog-error" }
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message,
  })
  expect(messages[0]).toMatchObject({
    type: "routineAuthorityServices",
    requestID: "catalog-error",
    error: "Raya is not connected.",
  })

  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async () =>
      Response.json({
        services: [
          { name: "github", tools: ["shared_tool"] },
          { name: "slack", tools: ["shared_tool"] },
        ],
        truncated: false,
      }),
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, requestID: "catalog-malformed" },
  })
  expect(messages[1]).toMatchObject({
    type: "routineAuthorityServices",
    requestID: "catalog-malformed",
    error: "The connected service list could not be verified. Reload the routine.",
  })
  expect(messages[1]).not.toHaveProperty("services")
})
