import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleRoutineMessage } from "../../src/kilo-provider/routines"

test("routine inbox page send read and draft keep request identity and retry the same source", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  let payload: { source?: string; body?: string } | undefined
  const note = {
    id: "rmg_1",
    agentID: "routine",
    kind: "report",
    source: "report:occ1",
    body: "Friday expenses increased.",
    time: 100,
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/agent-inbox") && request.method === "GET")
        return Response.json([
          {
            agentID: "routine",
            conversationID: "rcv_1",
            name: "Books",
            role: "accountant",
            latest: note,
            unread: 1,
            state: "scheduled",
          },
        ])
      if (url.pathname.endsWith("/inbox") && request.method === "GET")
        return Response.json({ messages: [note] })
      if (url.pathname.endsWith("/inbox") && request.method === "POST") {
        payload = await request.json()
        return Response.json({
          id: "rmg_user",
          agentID: "routine",
          kind: "user",
          source: payload.source,
          body: payload.body,
          time: 200,
        })
      }
      if (url.pathname.endsWith("/read")) return Response.json({ at: 200 })
      if (url.pathname.endsWith("/draft")) return Response.json({ draft: "Why?" })
      return new Response("missing", { status: 404 })
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineInboxPage", requestID: "page1", agentID: "routine" },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineInboxPage",
    requestID: "page1",
    agentID: "routine",
    messages: [note],
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineInboxSend", requestID: "send1", agentID: "routine", source: "user:retry", body: "Why?" },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineInboxSent",
    requestID: "send1",
    message: { source: "user:retry", body: "Why?" },
  })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineInboxRead", requestID: "read1", agentID: "routine", at: 200 },
  })
  expect(messages.at(-1)).toMatchObject({ type: "routineInboxRead", requestID: "read1", at: 200 })
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineInboxDraft", requestID: "draft1", agentID: "routine", draft: "Why?" },
  })
  expect(messages.at(-1)).toMatchObject({ type: "routineInboxDraft", requestID: "draft1", draft: "Why?" })
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post,
    message: { type: "routineInboxSend", requestID: "offline", agentID: "routine", source: "user:retry", body: "Why?" },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineInboxSent",
    requestID: "offline",
    error: "Raya is not connected.",
  })
  expect(payload).toEqual({ source: "user:retry", body: "Why?" })
})
