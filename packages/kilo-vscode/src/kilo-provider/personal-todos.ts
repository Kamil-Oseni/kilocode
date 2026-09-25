import type { KiloClient, PersonalTodoStaleRevisionError } from "@kilocode/sdk/v2/client"

type Message =
  | { type: "personalTodoList"; requestID: string }
  | { type: "personalTodoCreate"; requestID: string; title: string; reminderAt?: number }
  | {
      type: "personalTodoUpdate"
      requestID: string
      todoID: string
      revision: number
      title?: string
      detail?: string | null
      done?: boolean
      dueAt?: number | null
      reminderAt?: number | null
    }
  | { type: "personalTodoDelete"; requestID: string; todoID: string; revision: number }
  | {
      type: "personalTodoSubtask"
      requestID: string
      todoID: string
      subtaskID: string
      revision: number
      subtaskRevision: number
      done: boolean
    }

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

function operation(type: Message["type"]): "list" | "create" | "update" | "delete" | "subtask" {
  if (type === "personalTodoList") return "list"
  if (type === "personalTodoCreate") return "create"
  if (type === "personalTodoUpdate") return "update"
  if (type === "personalTodoSubtask") return "subtask"
  return "delete"
}

function handles(type: string) {
  return (
    type === "personalTodoList" ||
    type === "personalTodoCreate" ||
    type === "personalTodoUpdate" ||
    type === "personalTodoSubtask" ||
    type === "personalTodoDelete"
  )
}

function update(message: Extract<Message, { type: "personalTodoUpdate" }>) {
  const changed =
    message.title !== undefined ||
    message.detail !== undefined ||
    message.done !== undefined ||
    message.dueAt !== undefined ||
    message.reminderAt !== undefined
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
  if (!stamp(message.dueAt)) return false
  return stamp(message.reminderAt)
}

function stamp(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15)
  )
}

function valid(message: Message) {
  if (typeof message.requestID !== "string" || !message.requestID) return false
  if (message.type === "personalTodoList") return true
  if (message.type === "personalTodoCreate")
    return (
      typeof message.title === "string" &&
      Boolean(message.title.trim()) &&
      message.reminderAt !== null &&
      stamp(message.reminderAt)
    )
  if (
    !(
      typeof message.todoID === "string" &&
      Boolean(message.todoID) &&
      Number.isSafeInteger(message.revision) &&
      message.revision > 0
    )
  )
    return false
  if (message.type === "personalTodoSubtask")
    return (
      typeof message.subtaskID === "string" &&
      Boolean(message.subtaskID) &&
      Number.isSafeInteger(message.subtaskRevision) &&
      message.subtaskRevision > 0 &&
      typeof message.done === "boolean"
    )
  if (message.type === "personalTodoDelete") return true
  return update(message)
}

async function failed(input: {
  client: KiloClient
  directory: string
  message: Exclude<Message, { type: "personalTodoList" | "personalTodoCreate" }>
  operation: "update" | "delete" | "subtask"
  result: Result
  post: Post
}) {
  const conflict = input.result.response.status === 409 ? stale(input.result.error) : undefined
  const child = input.result.response.status === 409 ? subtaskStale(input.result.error) : undefined
  if (conflict || child) {
    input.post({
      type: "personalTodoResult",
      requestID: input.message.requestID,
      operation: input.operation,
      todoID: input.message.todoID,
      ...(input.message.type === "personalTodoSubtask" ? { subtaskID: input.message.subtaskID } : {}),
      error: {
        kind: "stale",
        message: (conflict ?? child)!.data.message,
        expected: (conflict ?? child)!.data.expected,
        actual: (conflict ?? child)!.data.actual,
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

function subtaskStale(value: unknown) {
  if (!value || typeof value !== "object") return
  const error = value as { name?: unknown; data?: { expected?: unknown; actual?: unknown; message?: unknown } }
  if (error.name !== "PersonalTodoSubtaskStaleRevisionError" || !error.data) return
  if (typeof error.data.expected !== "number" || typeof error.data.actual !== "number") return
  if (typeof error.data.message !== "string") return
  return error as { data: { expected: number; actual: number; message: string } }
}

async function saveSubtask(input: {
  client: KiloClient
  directory: string
  message: Extract<Message, { type: "personalTodoSubtask" }>
  post: Post
}) {
  const msg = input.message
  const params = {
    directory: input.directory,
    todoID: msg.todoID,
    subtaskID: msg.subtaskID,
    revision: msg.revision,
    subtaskRevision: msg.subtaskRevision,
  }
  try {
    const result = msg.done
      ? await input.client.raya.personalTodo.completeSubtask(params)
      : await input.client.raya.personalTodo.reopenSubtask(params)
    if (result.data) {
      input.post({ type: "personalTodoResult", requestID: msg.requestID, operation: "subtask", item: result.data })
      return true
    }
    await failed({ ...input, operation: "subtask", result })
    return true
  } catch {
    input.post({
      type: "personalTodoResult",
      requestID: msg.requestID,
      operation: "subtask",
      todoID: msg.todoID,
      subtaskID: msg.subtaskID,
      error: {
        kind: "offline",
        message: "The connection ended before Raya confirmed this step. Refresh the task before trying again.",
      },
    })
    return true
  }
}

export async function handlePersonalTodoMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
}): Promise<boolean> {
  if (!handles(input.message.type)) return false
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
  if (msg.type === "personalTodoSubtask")
    return saveSubtask({ client: input.client, directory: input.directory, message: msg, post: input.post })
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
      const result = await input.client.raya.personalTodo.create({
        directory: input.directory,
        title: msg.title,
        reminderAt: msg.reminderAt ?? undefined,
      })
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
        reminderAt: msg.reminderAt,
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
