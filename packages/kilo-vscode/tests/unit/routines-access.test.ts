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
      return Response.json({ id: "routine", access: "brief" })
    },
  })
  const message = {
    type: "routineAccessUpdate",
    requestID: "review",
    agentID: "routine",
    access: "brief",
    expectedAccess: "unset",
  }
  await handleRoutineMessage({ client, directory: "workspace", post: (msg) => messages.push(msg), message })
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe("PATCH")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("workspace")
  expect(await calls[0].json()).toEqual({ access: "brief", expectedAccess: "unset" })
  expect(messages[0]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    agentID: "routine",
    access: "brief",
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
  })
  await handleRoutineMessage({ client: null, directory: "workspace", post: (msg) => messages.push(msg), message })
  expect(messages[2]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "review",
    error: "Raya is not connected.",
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { ...message, access: "full", requestID: "mismatch" },
  })
  expect(messages[3]).toMatchObject({
    type: "routineAccessUpdated",
    requestID: "mismatch",
    error: "The saved access could not be confirmed. Reload the routine before trying again.",
  })
})
