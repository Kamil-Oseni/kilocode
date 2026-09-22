import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("Routine chat info loads, authorizes, revokes, and restores its exact owner report destination", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const agentID = "books"
  const base = {
    version: 1 as const,
    id: `ctd_${"1".repeat(48)}`,
    source: `routine-owner:${agentID}`,
    channel: "raya" as const,
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "agent" as const, id: agentID },
    createdAt: 1,
  }
  let target:
    | (typeof base & {
        revision: number
        enabled: boolean
        updatedAt: number
        revokedAt?: number
        quiet?: { start: number; end: number; timezone: string }
      })
    | undefined
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (request.method === "GET") return Response.json(target ? [target] : [])
      if (url.pathname.endsWith("/policy")) {
        const payload = (await request.clone().json()) as {
          revision: number
          quiet: { start: number; end: number; timezone: string } | null
        }
        target = {
          ...target!,
          revision: target!.revision + 1,
          updatedAt: target!.updatedAt + 1,
          ...(payload.quiet ? { quiet: payload.quiet } : {}),
        }
        return Response.json(target)
      }
      if (url.pathname.endsWith("/revoke")) {
        target = {
          ...target!,
          revision: target!.revision + 1,
          enabled: false,
          revokedAt: target!.updatedAt + 1,
          updatedAt: target!.updatedAt + 1,
        }
        return Response.json(target)
      }
      target = {
        ...base,
        revision: target ? target.revision + 1 : 1,
        enabled: true,
        updatedAt: target ? target.updatedAt + 1 : 1,
        ...(target?.quiet ? { quiet: target.quiet } : {}),
      }
      return Response.json(target)
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  const send = (
    action: "load" | "enable" | "disable" | "save",
    requestID: string,
    quiet?: { start: number; end: number; timezone: string } | null,
  ) =>
    handleRoutineMessage({
      client,
      directory: "workspace",
      post,
      message: {
        type: "routineContactDestination",
        requestID,
        agentID,
        action,
        ...(action === "save" ? { quiet } : {}),
      },
    })

  await send("load", "load-empty")
  await send("enable", "enable")
  await send("load", "load-enabled")
  await send("save", "quiet", { start: 1320, end: 420, timezone: "America/Toronto" })
  await send("disable", "disable")
  await send("enable", "restore")

  expect(messages).toEqual([
    expect.objectContaining({ type: "routineContactDestination", requestID: "load-empty", enabled: false }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "enable", enabled: true }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "load-enabled", enabled: true }),
    expect.objectContaining({
      type: "routineContactDestination",
      requestID: "quiet",
      enabled: true,
      quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
    }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "disable", enabled: false }),
    expect.objectContaining({
      type: "routineContactDestination",
      requestID: "restore",
      enabled: true,
      quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
    }),
  ])
  expect(new URL(calls[0].url).searchParams.get("agentID")).toBe(agentID)
  expect(new URL(calls[0].url).searchParams.get("limit")).toBe("1")
  const authorize = calls.find(
    (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/raya/contact/destinations"),
  )
  if (!authorize) throw new Error("expected destination authorization request")
  expect(await authorize.clone().json()).toEqual({
    source: `routine-owner:${agentID}`,
    channel: "raya",
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "agent", id: agentID },
  })
  const policy = calls.find((request) => new URL(request.url).pathname.endsWith("/policy"))
  if (!policy) throw new Error("expected quiet-hours policy request")
  expect(await policy.clone().json()).toEqual({
    revision: 1,
    quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
  })
  const revoke = calls.find((request) => new URL(request.url).pathname.endsWith("/revoke"))
  if (!revoke) throw new Error("expected destination revocation request")
  expect(await revoke.clone().json()).toEqual({ revision: 2 })
  const restores = calls.filter(
    (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/raya/contact/destinations"),
  )
  expect(await restores.at(-1)!.clone().json()).toMatchObject({
    quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
  })
  expect(target).toMatchObject({ revision: 4, enabled: true })

  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post,
    message: { type: "routineContactDestination", requestID: "offline", agentID, action: "load" },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineContactDestination",
    requestID: "offline",
    error: "Raya is not connected.",
  })
})

test("Organization report settings authorize and load only their exact owner destination", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const organizationID = "org_accounts"
  const target = {
    version: 1 as const,
    id: `ctd_${"2".repeat(48)}`,
    source: `routine-owner:organization:${organizationID}`,
    channel: "raya" as const,
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "organization" as const, id: organizationID },
    revision: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.method === "GET") return Response.json(calls.length === 1 ? [] : [target])
      return Response.json(target)
    },
  })
  const post = (msg: unknown) => messages.push(msg)

  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineContactDestination", requestID: "empty", organizationID, action: "load" },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineContactDestination", requestID: "enable", organizationID, action: "enable" },
  })

  expect(messages).toEqual([
    expect.objectContaining({
      type: "routineContactDestination",
      requestID: "empty",
      organizationID,
      enabled: false,
    }),
    expect.objectContaining({
      type: "routineContactDestination",
      requestID: "enable",
      organizationID,
      enabled: true,
    }),
  ])
  expect(new URL(calls[0].url).searchParams.get("organizationID")).toBe(organizationID)
  expect(new URL(calls[0].url).searchParams.has("agentID")).toBe(false)
  const authorize = calls.find((request) => request.method === "POST")
  if (!authorize) throw new Error("expected organization destination authorization request")
  expect(await authorize.clone().json()).toEqual({
    source: `routine-owner:organization:${organizationID}`,
    channel: "raya",
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "organization", id: organizationID },
  })

  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineContactDestination",
      requestID: "ambiguous",
      agentID: "books",
      organizationID,
      action: "load",
    },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineContactDestination",
    requestID: "ambiguous",
    agentID: "books",
    organizationID,
    error: "Reload this report setting before changing it.",
  })

  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineContactDestination",
      requestID: "three-scopes",
      global: true,
      agentID: "books",
      organizationID,
      action: "load",
    },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineContactDestination",
    requestID: "three-scopes",
    global: true,
    agentID: "books",
    organizationID,
    error: "Reload this report setting before changing it.",
  })
})

test("All workers report settings use the exact global Raya inbox destination", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const target = {
    version: 1 as const,
    id: `ctd_${"3".repeat(48)}`,
    source: "routine-owner:global",
    channel: "raya" as const,
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "global" as const },
    revision: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (request.method === "GET") return Response.json([])
      return Response.json(target)
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineContactDestination", requestID: "global-load", global: true, action: "load" },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineContactDestination", requestID: "global-enable", global: true, action: "enable" },
  })
  expect(messages).toEqual([
    expect.objectContaining({ requestID: "global-load", global: true, enabled: false }),
    expect.objectContaining({ requestID: "global-enable", global: true, enabled: true }),
  ])
  const query = new URL(calls[0].url).searchParams
  expect(query.get("global")).toBe("true")
  expect(query.has("agentID")).toBe(false)
  expect(query.has("organizationID")).toBe(false)
  const authorized = calls.find((request) => request.method === "POST")
  if (!authorized) throw new Error("expected global destination authorization request")
  expect(await authorized.clone().json()).toEqual({
    source: "routine-owner:global",
    channel: "raya",
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "global" },
  })
})
