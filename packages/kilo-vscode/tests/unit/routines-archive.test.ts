import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("archive requests use read-only generated APIs and correlate list, history and errors", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (new URL(request.url).pathname.endsWith("/agent-archive"))
        return Response.json({
          items: [{ version: 1, archivedAt: 1234, definition: { id: "removed", name: "Removed" } }],
          next: "removed",
        })
      if (new URL(request.url).pathname.endsWith("/inbox"))
        return Response.json({
          messages: [
            {
              id: "rmg_1",
              agentID: "removed",
              kind: "report",
              source: "report:occ_1",
              body: "Friday receipts are missing.",
              time: 1234,
            },
          ],
        })
      return Response.json([{ id: "run", agentID: "removed", sessionID: "session", at: 1234, status: "complete" }])
    },
  })
  for (const agentID of [undefined, "removed", "other"])
    await handleRoutineMessage({
      client,
      directory: "workspace",
      post: (msg) => messages.push(msg),
      message: { type: "routineArchive", requestID: agentID ?? "list", agentID },
    })
  expect(calls.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET"])
  expect(calls.every((request) => new URL(request.url).searchParams.get("directory") === "workspace")).toBe(true)
  expect(new URL(calls[1].url).searchParams.get("agentID")).toBe("removed")
  expect(messages[0]).toMatchObject({
    type: "routineArchive",
    requestID: "list",
    next: "removed",
    archive: [{ definition: { id: "removed" } }],
  })
  expect(messages[1]).toMatchObject({
    type: "routineArchive",
    requestID: "removed",
    agentID: "removed",
    runs: [{ id: "run" }],
    messages: [{ id: "rmg_1", agentID: "removed", body: "Friday receipts are missing." }],
  })
  expect(messages[2]).toMatchObject({
    type: "routineArchive",
    requestID: "other",
    agentID: "other",
    error: "This routine is no longer in the archive. Refresh the list.",
  })
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { type: "routineArchive", requestID: "offline" },
  })
  expect(messages[3]).toMatchObject({ type: "routineArchive", requestID: "offline", error: "Raya is not connected." })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post: (msg) => messages.push(msg),
    message: { type: "routineArchive", requestID: "page", cursor: "removed" },
  })
  expect(new URL(calls.at(-1)!.url).searchParams.get("cursor")).toBe("removed")
  expect(new URL(calls.at(-1)!.url).searchParams.has("agentID")).toBe(false)
  expect(messages[4]).toMatchObject({ type: "routineArchive", requestID: "page", next: "removed" })
})
