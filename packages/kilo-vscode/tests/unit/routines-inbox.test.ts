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

test("routine delegate posts the same source on retry and refreshes inbox summaries", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  let payload: Record<string, unknown> | undefined
  const record = {
    id: "rdl_1",
    source: "dlg:retry",
    senderID: "chief",
    recipientID: "books",
    objective: "Review Friday expenses.",
    state: "queued",
  }
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/delegate") && request.method === "POST") {
        payload = (await request.json()) as Record<string, unknown>
        return Response.json(record)
      }
      if (url.pathname.endsWith("/agent-inbox") && request.method === "GET")
        return Response.json([
          {
            agentID: "chief",
            conversationID: "rcv_chief",
            name: "Chief of Staff",
            role: "briefer",
            unread: 0,
            state: "scheduled",
          },
        ])
      return new Response("missing", { status: 404 })
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: {
      type: "routineDelegate",
      requestID: "dlg1",
      agentID: "chief",
      recipientID: "books",
      source: "dlg:retry",
      objective: "Review Friday expenses.",
    },
  })
  expect(payload).toEqual({
    source: "dlg:retry",
    senderID: "chief",
    recipientID: "books",
    objective: "Review Friday expenses.",
  })
  expect(calls.some((item) => new URL(item.url).pathname.endsWith("/agent/chief/delegate"))).toBe(true)
  expect(messages.filter((msg) => (msg as { type?: string }).type === "routineDelegated").at(-1)).toMatchObject({
    type: "routineDelegated",
    requestID: "dlg1",
    agentID: "chief",
    record,
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineInbox",
    requestID: "dlg1",
    items: [{ agentID: "chief" }],
  })
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post,
    message: {
      type: "routineDelegate",
      requestID: "offline",
      agentID: "chief",
      recipientID: "books",
      source: "dlg:retry",
      objective: "Review Friday expenses.",
    },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineDelegated",
    requestID: "offline",
    error: "Raya is not connected.",
  })
})

test("routine delegate cancel posts the request id and refreshes inbox summaries", async () => {
  const messages: unknown[] = []
  let path = ""
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/cancel") && request.method === "POST") {
        path = url.pathname
        return Response.json({
          id: "rdl_1",
          source: "dlg:retry",
          senderID: "chief",
          recipientID: "books",
          objective: "Review Friday expenses.",
          state: "cancelled",
        })
      }
      if (url.pathname.endsWith("/agent-inbox") && request.method === "GET")
        return Response.json([
          {
            agentID: "chief",
            conversationID: "rcv_chief",
            name: "Chief of Staff",
            role: "briefer",
            unread: 1,
            state: "scheduled",
          },
        ])
      return new Response("missing", { status: 404 })
    },
  })
  const post = (msg: unknown) => messages.push(msg)
  await handleRoutineMessage({
    client,
    directory: "workspace",
    post,
    message: { type: "routineDelegateCancel", requestID: "stop1", agentID: "chief", id: "rdl_1" },
  })
  expect(path).toBe("/kilocode/agent/chief/delegate/rdl_1/cancel")
  expect(messages.filter((msg) => (msg as { type?: string }).type === "routineDelegateStopped").at(-1)).toMatchObject({
    type: "routineDelegateStopped",
    requestID: "stop1",
    agentID: "chief",
    record: { id: "rdl_1", state: "cancelled" },
  })
  expect(messages.at(-1)).toMatchObject({ type: "routineInbox", requestID: "stop1" })
  await handleRoutineMessage({
    client: null,
    directory: "workspace",
    post,
    message: { type: "routineDelegateCancel", requestID: "offline", agentID: "chief", id: "rdl_1" },
  })
  expect(messages.at(-1)).toMatchObject({
    type: "routineDelegateStopped",
    requestID: "offline",
    error: "Raya is not connected.",
  })
})
