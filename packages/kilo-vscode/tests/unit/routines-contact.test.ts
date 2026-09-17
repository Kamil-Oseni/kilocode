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
  let target: (typeof base & { revision: number; enabled: boolean; updatedAt: number; revokedAt?: number }) | undefined
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (request.method === "GET") return Response.json(target ? [target] : [])
      if (url.pathname.endsWith("/revoke")) {
        target = { ...target!, revision: 2, enabled: false, revokedAt: 2, updatedAt: 2 }
        return Response.json(target)
      }
      target = { ...base, revision: target ? 3 : 1, enabled: true, updatedAt: target ? 3 : 1 }
      return Response.json(target)
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  const send = (action: "load" | "enable" | "disable", requestID: string) =>
    handleRoutineMessage({
      client,
      directory: "workspace",
      post,
      message: { type: "routineContactDestination", requestID, agentID, action },
    })

  await send("load", "load-empty")
  await send("enable", "enable")
  await send("load", "load-enabled")
  await send("disable", "disable")
  await send("enable", "restore")

  expect(messages).toEqual([
    expect.objectContaining({ type: "routineContactDestination", requestID: "load-empty", enabled: false }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "enable", enabled: true }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "load-enabled", enabled: true }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "disable", enabled: false }),
    expect.objectContaining({ type: "routineContactDestination", requestID: "restore", enabled: true }),
  ])
  expect(new URL(calls[0].url).searchParams.get("agentID")).toBe(agentID)
  expect(new URL(calls[0].url).searchParams.get("limit")).toBe("1")
  expect(await calls[2].json()).toEqual({
    source: `routine-owner:${agentID}`,
    channel: "raya",
    address: "owner",
    label: "Raya inbox",
    scope: { kind: "agent", id: agentID },
  })
  expect(await calls[5].json()).toEqual({ revision: 1 })
  expect(target).toMatchObject({ revision: 3, enabled: true })

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
