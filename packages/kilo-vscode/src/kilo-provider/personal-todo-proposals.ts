import type {
  KiloClient,
  PersonalTodoProposalStaleRevisionError,
  RayaPersonalTodoGetProposalResponse,
} from "@kilocode/sdk/v2/client"

type Message =
  | { type: "personalTodoProposalList"; requestID: string }
  | { type: "personalTodoProposalGet"; requestID: string; proposalID: string }
  | { type: "personalTodoProposalApply"; requestID: string; proposalID: string; digest: string }
  | { type: "personalTodoProposalReject"; requestID: string; proposalID: string; digest: string }

type Action = "list" | "get" | "apply" | "reject"
type View = RayaPersonalTodoGetProposalResponse
type Post = (message: unknown) => void
type Result = { error?: unknown; response: { status: number } }

const hash = /^[a-f0-9]{64}$/

function text(value: unknown) {
  if (!value || typeof value !== "object") return
  const data = value as { message?: unknown; data?: unknown }
  if (typeof data.message === "string") return data.message
  if (!data.data || typeof data.data !== "object") return
  const nested = data.data as { message?: unknown }
  return typeof nested.message === "string" ? nested.message : undefined
}

function stale(value: unknown): PersonalTodoProposalStaleRevisionError | undefined {
  if (!value || typeof value !== "object") return
  const error = value as Partial<PersonalTodoProposalStaleRevisionError>
  if (error.name !== "PersonalTodoProposalStaleRevisionError" || !error.data) return
  if (typeof error.data.expected !== "number") return
  if (error.data.actual !== undefined && typeof error.data.actual !== "number") return
  return error as PersonalTodoProposalStaleRevisionError
}

function action(type: "personalTodoProposalApply" | "personalTodoProposalReject"): "apply" | "reject"
function action(type: Message["type"]): Action
function action(type: Message["type"]): Action {
  if (type === "personalTodoProposalList") return "list"
  if (type === "personalTodoProposalGet") return "get"
  if (type === "personalTodoProposalApply") return "apply"
  return "reject"
}

function valid(message: Message) {
  if (typeof message.requestID !== "string" || !message.requestID) return false
  if (message.type === "personalTodoProposalList") return true
  if (typeof message.proposalID !== "string" || !message.proposalID) return false
  if (message.type === "personalTodoProposalGet") return true
  return typeof message.digest === "string" && hash.test(message.digest)
}

async function get(client: KiloClient, directory: string, proposalID: string) {
  return client.raya.personalTodo.getProposal({ proposalID, directory }).then(
    (result) => result.data,
    () => undefined,
  )
}

function failure(input: { message: Message; action: Action; result: Result; post: Post }) {
  const error = input.result.response.status === 409 ? stale(input.result.error) : undefined
  if (error) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: input.message.requestID,
      operation: input.action,
      proposalID: error.data.proposalID,
      kind: "stale",
      message: error.data.message,
      todoID: error.data.todoID,
      expected: error.data.expected,
      actual: error.data.actual,
    })
    return
  }
  if (input.result.response.status === 409) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: input.message.requestID,
      operation: input.action,
      ...(input.message.type === "personalTodoProposalList" ? {} : { proposalID: input.message.proposalID }),
      kind: "conflict",
      message: text(input.result.error) ?? "This Todo proposal conflicts with its saved state.",
    })
    return
  }
  input.post({
    type: "personalTodoProposalResult",
    requestID: input.message.requestID,
    operation: input.action,
    ...(input.message.type === "personalTodoProposalList" ? {} : { proposalID: input.message.proposalID }),
    kind: "error",
    message: text(input.result.error) ?? "Raya could not complete this Todo proposal request.",
  })
}

async function uncertain(input: {
  client: KiloClient
  directory: string
  message: Extract<Message, { type: "personalTodoProposalApply" | "personalTodoProposalReject" }>
  post: Post
}) {
  const operation = action(input.message.type)
  const expected = operation === "apply" ? "applied" : "rejected"
  const item = await get(input.client, input.directory, input.message.proposalID)
  if (item?.state === expected) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: input.message.requestID,
      operation,
      proposalID: input.message.proposalID,
      kind: expected,
      item,
    })
    return
  }
  if (item && (item.state === "applied" || item.state === "rejected")) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: input.message.requestID,
      operation,
      proposalID: input.message.proposalID,
      kind: "conflict",
      message: `The Todo proposal is already ${item.state}.`,
      item,
    })
    return
  }
  input.post({
    type: "personalTodoProposalResult",
    requestID: input.message.requestID,
    operation,
    proposalID: input.message.proposalID,
    kind: "uncertain",
    message: "The connection was interrupted before Raya confirmed the proposal state.",
    ...(item ? { item } : {}),
  })
}

async function missed(input: {
  client: KiloClient
  directory: string
  message: Extract<Message, { type: "personalTodoProposalApply" | "personalTodoProposalReject" }>
  action: "apply" | "reject"
  result: Result
  post: Post
}) {
  if (input.result.response.status === 408 || input.result.response.status >= 500) {
    await uncertain(input)
    return
  }
  failure(input)
}

export async function handlePersonalTodoProposalMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
}): Promise<boolean> {
  if (
    input.message.type !== "personalTodoProposalList" &&
    input.message.type !== "personalTodoProposalGet" &&
    input.message.type !== "personalTodoProposalApply" &&
    input.message.type !== "personalTodoProposalReject"
  )
    return false
  const message = input.message as Message
  const operation = action(message.type)
  if (!valid(message)) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: typeof message.requestID === "string" ? message.requestID : "invalid",
      operation,
      kind: "error",
      message: "This Todo proposal request was incomplete.",
    })
    return true
  }
  if (!input.client) {
    input.post({
      type: "personalTodoProposalResult",
      requestID: message.requestID,
      operation,
      ...(message.type === "personalTodoProposalList" ? {} : { proposalID: message.proposalID }),
      kind: "offline",
      message: "Raya is offline.",
    })
    return true
  }
  try {
    if (message.type === "personalTodoProposalList") {
      const result = await input.client.raya.personalTodo.listProposals({ directory: input.directory })
      if (result.data) {
        input.post({
          type: "personalTodoProposalResult",
          requestID: message.requestID,
          operation,
          kind: "listed",
          items: result.data,
        })
        return true
      }
      failure({ message, action: operation, result, post: input.post })
      return true
    }
    if (message.type === "personalTodoProposalGet") {
      const result = await input.client.raya.personalTodo.getProposal({
        directory: input.directory,
        proposalID: message.proposalID,
      })
      if (result.data) {
        input.post({
          type: "personalTodoProposalResult",
          requestID: message.requestID,
          operation,
          proposalID: message.proposalID,
          kind: "loaded",
          item: result.data,
        })
        return true
      }
      failure({ message, action: operation, result, post: input.post })
      return true
    }
    const decision = action(message.type)
    const params = { directory: input.directory, proposalID: message.proposalID, digest: message.digest }
    const result =
      message.type === "personalTodoProposalApply"
        ? await input.client.raya.personalTodo.applyProposal(params)
        : await input.client.raya.personalTodo.rejectProposal(params)
    if (result.data) {
      input.post({
        type: "personalTodoProposalResult",
        requestID: message.requestID,
        operation: decision,
        proposalID: message.proposalID,
        kind: decision === "apply" ? "applied" : "rejected",
        item: result.data,
      })
      return true
    }
    await missed({
      client: input.client,
      directory: input.directory,
      message,
      action: decision,
      result,
      post: input.post,
    })
    return true
  } catch {
    if (message.type === "personalTodoProposalApply" || message.type === "personalTodoProposalReject") {
      await uncertain({ client: input.client, directory: input.directory, message, post: input.post })
      return true
    }
    input.post({
      type: "personalTodoProposalResult",
      requestID: message.requestID,
      operation,
      ...(message.type === "personalTodoProposalList" ? {} : { proposalID: message.proposalID }),
      kind: "offline",
      message: "The connection was interrupted.",
    })
    return true
  }
}
