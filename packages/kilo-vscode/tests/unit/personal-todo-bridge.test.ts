import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { handlePersonalTodoMessage } from "../../src/kilo-provider/personal-todos"

const item = {
  version: 1 as const,
  id: "todo_1",
  title: "Review accounts",
  done: false,
  createdAt: 1,
  updatedAt: 1,
  revision: 3,
}

function client(personalTodo: Record<string, (...args: never[]) => unknown>) {
  return { raya: { personalTodo } } as unknown as KiloClient
}

describe("personal todo extension bridge", () => {
  it("uses the typed CRUD endpoints and keeps required revisions", async () => {
    const calls: unknown[] = []
    const api = client({
      list: async (input: unknown) => {
        calls.push(["list", input])
        return { data: [item], response: { status: 200 } }
      },
      create: async (input: unknown) => {
        calls.push(["create", input])
        return { data: item, response: { status: 200 } }
      },
      update: async (input: unknown) => {
        calls.push(["update", input])
        return { data: { ...item, done: true, revision: 4 }, response: { status: 200 } }
      },
      delete: async (input: unknown) => {
        calls.push(["delete", input])
        return { data: true, response: { status: 200 } }
      },
    })
    const messages: unknown[] = []
    const post = (message: unknown) => messages.push(message)

    await handlePersonalTodoMessage({
      client: api,
      directory: "C:/work",
      message: { type: "personalTodoList", requestID: "1" },
      post,
    })
    await handlePersonalTodoMessage({
      client: api,
      directory: "C:/work",
      message: { type: "personalTodoCreate", requestID: "2", title: "Review accounts" },
      post,
    })
    await handlePersonalTodoMessage({
      client: api,
      directory: "C:/work",
      message: {
        type: "personalTodoUpdate",
        requestID: "3",
        todoID: item.id,
        revision: 3,
        title: "Review quarterly accounts",
        detail: null,
        dueAt: 1_800_000,
      },
      post,
    })
    await handlePersonalTodoMessage({
      client: api,
      directory: "C:/work",
      message: { type: "personalTodoDelete", requestID: "4", todoID: item.id, revision: 4 },
      post,
    })

    expect(calls).toEqual([
      ["list", { directory: "C:/work" }],
      ["create", { directory: "C:/work", title: "Review accounts" }],
      [
        "update",
        {
          directory: "C:/work",
          todoID: item.id,
          revision: 3,
          title: "Review quarterly accounts",
          detail: null,
          done: undefined,
          dueAt: 1_800_000,
        },
      ],
      ["delete", { directory: "C:/work", todoID: item.id, revision: "4" }],
    ])
    expect(messages).toHaveLength(4)
    expect(messages.at(-1)).toMatchObject({ operation: "delete", todoID: item.id, removed: true })
  })

  it("maps an exact stale response and retrieves the latest saved item", async () => {
    const latest = { ...item, title: "Updated elsewhere", revision: 5 }
    const api = client({
      update: async () => ({
        error: {
          name: "PersonalTodoStaleRevisionError",
          data: { id: item.id, operation: "update", expected: 3, actual: 5, message: "Todo changed elsewhere." },
        },
        response: { status: 409 },
      }),
      get: async () => ({ data: latest, response: { status: 200 } }),
    })
    const messages: unknown[] = []
    await handlePersonalTodoMessage({
      client: api,
      directory: "C:/work",
      message: { type: "personalTodoUpdate", requestID: "stale", todoID: item.id, revision: 3, done: true },
      post: (message) => messages.push(message),
    })

    expect(messages).toEqual([
      {
        type: "personalTodoResult",
        requestID: "stale",
        operation: "update",
        todoID: item.id,
        error: {
          kind: "stale",
          message: "Todo changed elsewhere.",
          expected: 3,
          actual: 5,
          latest,
        },
      },
    ])
  })

  it("reports offline requests without losing their request identity", async () => {
    const messages: unknown[] = []
    await handlePersonalTodoMessage({
      client: null,
      directory: "C:/work",
      message: { type: "personalTodoCreate", requestID: "offline", title: "Kept draft" },
      post: (message) => messages.push(message),
    })
    expect(messages).toEqual([
      {
        type: "personalTodoResult",
        requestID: "offline",
        operation: "create",
        error: { kind: "offline", message: "Raya is offline. Your changes are still here." },
      },
    ])
  })

  it("rejects empty and invalid update payloads before calling the backend", async () => {
    const calls: unknown[] = []
    const api = client({
      update: async (input: unknown) => {
        calls.push(input)
        return { data: item, response: { status: 200 } }
      },
    })
    const messages: unknown[] = []
    for (const [requestID, fields] of [
      ["empty", {}],
      ["title", { title: " " }],
      ["detail", { detail: "x".repeat(10_001) }],
      ["due", { dueAt: Number.NaN }],
    ] as const)
      await handlePersonalTodoMessage({
        client: api,
        directory: "C:/work",
        message: { type: "personalTodoUpdate", requestID, todoID: item.id, revision: 3, ...fields },
        post: (message) => messages.push(message),
      })

    expect(calls).toEqual([])
    expect(messages).toHaveLength(4)
    for (const message of messages)
      expect(message).toMatchObject({ error: { kind: "error", message: "This todo request was incomplete." } })
  })
})
