import type { KiloClient, RayaFocusTimerGetResponse } from "@kilocode/sdk/v2/client"

type Action = "start" | "pause" | "resume" | "reset"
type Message =
  | { type: "focusTimerGet"; requestID: string }
  | { type: "focusTimerStart"; requestID: string; revision: number; durationMs: number; todoID?: string }
  | { type: "focusTimerPause"; requestID: string; revision: number }
  | { type: "focusTimerResume"; requestID: string; revision: number }
  | { type: "focusTimerReset"; requestID: string; revision: number }

type Post = (message: unknown) => void
type Result = { data?: RayaFocusTimerGetResponse; error?: unknown; response: { status: number } }
type Conflict = { message: string; expected: number; actual: number }

function stale(value: unknown): Conflict | undefined {
  if (!value || typeof value !== "object") return undefined
  if (!("name" in value) || value.name !== "FocusTimerStaleRevisionError") return undefined
  if (!("data" in value) || !value.data || typeof value.data !== "object") return undefined
  if (!("message" in value.data) || typeof value.data.message !== "string") return undefined
  if (!("expected" in value.data) || typeof value.data.expected !== "number") return undefined
  if (!("actual" in value.data) || typeof value.data.actual !== "number") return undefined
  return { message: value.data.message, expected: value.data.expected, actual: value.data.actual }
}

function action(type: Exclude<Message, { type: "focusTimerGet" }>["type"]): Action {
  if (type === "focusTimerStart") return "start"
  if (type === "focusTimerPause") return "pause"
  if (type === "focusTimerResume") return "resume"
  return "reset"
}

function operation(type: string): "get" | Action {
  if (type === "focusTimerGet") return "get"
  if (type === "focusTimerStart") return "start"
  if (type === "focusTimerPause") return "pause"
  if (type === "focusTimerResume") return "resume"
  return "reset"
}

function parse(message: { type: string } & Record<string, unknown>): Message | undefined {
  if (typeof message.requestID !== "string" || !message.requestID) return undefined
  if (message.type === "focusTimerGet") return { type: message.type, requestID: message.requestID }
  if (!Number.isSafeInteger(message.revision) || typeof message.revision !== "number" || message.revision < 1)
    return undefined
  if (message.type === "focusTimerPause" || message.type === "focusTimerResume" || message.type === "focusTimerReset")
    return { type: message.type, requestID: message.requestID, revision: message.revision }
  if (message.type !== "focusTimerStart") return undefined
  if (
    !Number.isSafeInteger(message.durationMs) ||
    typeof message.durationMs !== "number" ||
    message.durationMs < 60_000 ||
    message.durationMs > 86_400_000
  )
    return undefined
  if (message.todoID !== undefined && (typeof message.todoID !== "string" || !message.todoID)) return undefined
  return {
    type: message.type,
    requestID: message.requestID,
    revision: message.revision,
    durationMs: message.durationMs,
    todoID: message.todoID,
  }
}

async function latest(client: KiloClient, directory: string) {
  return client.raya.focusTimer.get({ directory }).then(
    (result) => result.data,
    () => undefined,
  )
}

async function failed(input: {
  client: KiloClient
  directory: string
  message: Exclude<Message, { type: "focusTimerGet" }>
  result: Result
  post: Post
}) {
  const operation = action(input.message.type)
  const conflict = input.result.response.status === 409 ? stale(input.result.error) : undefined
  if (conflict) {
    input.post({
      type: "focusTimerResult",
      requestID: input.message.requestID,
      operation,
      error: {
        kind: "stale",
        message: conflict.message,
        expected: conflict.expected,
        actual: conflict.actual,
        latest: await latest(input.client, input.directory),
      },
    })
    return
  }
  input.post({
    type: "focusTimerResult",
    requestID: input.message.requestID,
    operation,
    error: { kind: "error", message: "Raya could not update the focus timer." },
  })
}

export async function handleFocusTimerMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
}): Promise<boolean> {
  if (
    input.message.type !== "focusTimerGet" &&
    input.message.type !== "focusTimerStart" &&
    input.message.type !== "focusTimerPause" &&
    input.message.type !== "focusTimerResume" &&
    input.message.type !== "focusTimerReset"
  )
    return false
  const msg = parse(input.message)
  if (!msg) {
    input.post({
      type: "focusTimerResult",
      requestID: typeof input.message.requestID === "string" ? input.message.requestID : "invalid",
      operation: operation(input.message.type),
      error: { kind: "error", message: "This focus timer request was incomplete." },
    })
    return true
  }
  if (!input.client) {
    input.post({
      type: "focusTimerResult",
      requestID: msg.requestID,
      operation: operation(msg.type),
      error: { kind: "offline", message: "Raya is offline. The saved focus timer is unchanged." },
    })
    return true
  }
  try {
    const result =
      msg.type === "focusTimerGet"
        ? await input.client.raya.focusTimer.get({ directory: input.directory })
        : msg.type === "focusTimerStart"
          ? await input.client.raya.focusTimer.start({
              directory: input.directory,
              revision: msg.revision,
              durationMs: msg.durationMs,
              todoID: msg.todoID,
            })
          : msg.type === "focusTimerPause"
            ? await input.client.raya.focusTimer.pause({ directory: input.directory, revision: msg.revision })
            : msg.type === "focusTimerResume"
              ? await input.client.raya.focusTimer.resume({ directory: input.directory, revision: msg.revision })
              : await input.client.raya.focusTimer.reset({ directory: input.directory, revision: msg.revision })
    if (result.data) {
      input.post({
        type: "focusTimerResult",
        requestID: msg.requestID,
        operation: operation(msg.type),
        timer: result.data,
      })
      return true
    }
    if (msg.type !== "focusTimerGet") {
      await failed({ client: input.client, directory: input.directory, message: msg, result, post: input.post })
      return true
    }
    input.post({
      type: "focusTimerResult",
      requestID: msg.requestID,
      operation: "get",
      error: { kind: "error", message: "Raya could not load the focus timer." },
    })
    return true
  } catch {
    input.post({
      type: "focusTimerResult",
      requestID: msg.requestID,
      operation: operation(msg.type),
      error: { kind: "offline", message: "The connection was interrupted. The saved focus timer is unchanged." },
    })
    return true
  }
}
