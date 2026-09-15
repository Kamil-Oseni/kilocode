import type { KiloClient, PersonalTodoStaleRevisionError } from "@kilocode/sdk/v2/client"

type Message =
  | { type: "personalTodoList"; requestID: string }
  | { type: "personalTodoCreate"; requestID: string; title: string }
  | {
      type: "personalTodoUpdate"
      requestID: string
      todoID: string
      revision: number
      title?: string
      detail?: string | null
      done?: boolean
      dueAt?: number | null
    }
  | { type: "personalTodoDelete"; requestID: string; todoID: string; revision: number }

type Post = (message: unknown) => void
type Result = { error?: unknown; response: { status: number } }

function message(value: unknown) {
  if (!value || typeof value !== "object") return
  const data = value as { message?: unknown; data?: unknown }
  if (typeof data.message === "string") return data.message
  if (!data.data || typeof data.data !== "object") return
  const nested = data.data as { message?: unknown }
  return typeof nested.message === "string" ? nested.message : undefined
}

function stale(value: unknown): PersonalTodoStaleRevisionError | undefined {
  if (!value || typeof value !== "object") return
  const error = value as Partial<PersonalTodoStaleRevisionError>
  if (error.name !== "PersonalTodoStaleRevisionError" || !error.data) return
  if (typeof error.data.actual !== "number" || typeof error.data.expected !== "number") return
  return error as PersonalTodoStaleRevisionError
}

async function latest(client: KiloClient, directory: string, todoID: string) {
  return client.raya.personalTodo.get({ todoID, directory }).then(
    (result) => result.data,
    () => undefined,
  )
}

function operation(type: Message["type"]): "list" | "create" | "update" | "delete" {
  if (type === "personalTodoList") return "list"
  if (type === "personalTodoCreate") return "create"
  if (type === "personalTodoUpdate") return "update"
  return "delete"
}

function update(message: Extract<Message, { type: "personalTodoUpdate" }>) {
  const changed =
    message.title !== undefined ||
    message.detail !== undefined ||
    message.done !== undefined ||
    message.dueAt !== undefined
  if (!changed) return false
  if (
    message.title !== undefined &&
    (typeof message.title !== "string" || !message.title.trim() || message.title.length > 500)
  )
    return false
  if (
    message.detail !== undefined &&
    message.detail !== null &&
    (typeof message.detail !== "string" || message.detail.length > 10_000)
  )
    return false
  if (message.done !== undefined && typeof message.done !== "boolean") return false
  return (
    message.dueAt === undefined ||
    message.dueAt === null ||
    (typeof message.dueAt === "number" && Number.isFinite(message.dueAt) && Math.abs(message.dueAt) <= 8.64e15)
  )
}

function valid(message: Message) {
  if (typeof message.requestID !== "string" || !message.requestID) return false
  if (message.type === "personalTodoList") return true
  if (message.type === "personalTodoCreate") return typeof message.title === "string" && Boolean(message.title.trim())
  if (
    !(
      typeof message.todoID === "string" &&
      Boolean(message.todoID) &&
      Number.isSafeInteger(message.revision) &&
      message.revision > 0
    )
  )
    return false
  if (message.type === "personalTodoDelete") return true
  return update(message)
}

async function failed(input: {
  client: KiloClient
  directory: string
  message: Exclude<Message, { type: "personalTodoList" | "personalTodoCreate" }>
  operation: "update" | "delete"
  result: Result
  post: Post
}) {
  const conflict = input.result.response.status === 409 ? stale(input.result.error) : undefined
  if (conflict) {
    input.post({
      type: "personalTodoResult",
      requestID: input.message.requestID,
      operation: input.operation,
      todoID: input.message.todoID,
      error: {
        kind: "stale",
        message: conflict.data.message,
        expected: conflict.data.expected,
        actual: conflict.data.actual,
        latest: await latest(input.client, input.directory, input.message.todoID),
      },
    })
    return
  }
  input.post({
    type: "personalTodoResult",
    requestID: input.message.requestID,
    operation: input.operation,
    todoID: input.message.todoID,
    error: { kind: "error", message: message(input.result.error) ?? "Raya could not save this change." },
  })
}

export async function handlePersonalTodoMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
}): Promise<boolean> {
  if (
    input.message.type !== "personalTodoList" &&
    input.message.type !== "personalTodoCreate" &&
    input.message.type !== "personalTodoUpdate" &&
    input.message.type !== "personalTodoDelete"
  )
    return false
  const msg = input.message as Message
  if (!valid(msg)) {
    input.post({
      type: "personalTodoResult",
      requestID: typeof msg.requestID === "string" ? msg.requestID : "invalid",
      operation: operation(msg.type),
      error: { kind: "error", message: "This todo request was incomplete." },
    })
    return true
  }
  if (!input.client) {
    input.post({
      type: "personalTodoResult",
      requestID: msg.requestID,
      operation: operation(msg.type),
      error: { kind: "offline", message: "Raya is offline. Your changes are still here." },
    })
    return true
  }
  try {
    if (msg.type === "personalTodoList") {
      const result = await input.client.raya.personalTodo.list({ directory: input.directory })
      input.post(
        result.data
          ? { type: "personalTodoResult", requestID: msg.requestID, operation: "list", items: result.data }
          : {
              type: "personalTodoResult",
              requestID: msg.requestID,
              operation: "list",
              error: { kind: "error", message: message(result.error) ?? "Raya could not load your todos." },
            },
      )
      return true
    }
    if (msg.type === "personalTodoCreate") {
      const result = await input.client.raya.personalTodo.create({ directory: input.directory, title: msg.title })
      input.post(
        result.data
          ? { type: "personalTodoResult", requestID: msg.requestID, operation: "create", item: result.data }
          : {
              type: "personalTodoResult",
              requestID: msg.requestID,
              operation: "create",
              error: { kind: "error", message: message(result.error) ?? "Raya could not add this todo." },
            },
      )
      return true
    }
    if (msg.type === "personalTodoUpdate") {
      const params = {
        directory: input.directory,
        todoID: msg.todoID,
        revision: msg.revision,
        title: msg.title,
        detail: msg.detail,
        done: msg.done,
        dueAt: msg.dueAt,
      }
      const result = await input.client.raya.personalTodo.update(params)
      if (result.data) {
        input.post({ type: "personalTodoResult", requestID: msg.requestID, operation: "update", item: result.data })
        return true
      }
      await failed({
        client: input.client,
        directory: input.directory,
        message: msg,
        operation: "update",
        result,
        post: input.post,
      })
      return true
    }
    const result = await input.client.raya.personalTodo.delete({
      directory: input.directory,
      todoID: msg.todoID,
      revision: String(msg.revision),
    })
    if (result.data) {
      input.post({
        type: "personalTodoResult",
        requestID: msg.requestID,
        operation: "delete",
        todoID: msg.todoID,
        removed: true,
      })
      return true
    }
    await failed({
      client: input.client,
      directory: input.directory,
      message: msg,
      operation: "delete",
      result,
      post: input.post,
    })
    return true
  } catch {
    input.post({
      type: "personalTodoResult",
      requestID: msg.requestID,
      operation: operation(msg.type),
      error: { kind: "offline", message: "The connection was interrupted. Your changes are still here." },
    })
    return true
  }
}
