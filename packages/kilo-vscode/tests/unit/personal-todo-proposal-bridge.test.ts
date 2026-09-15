import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { handlePersonalTodoProposalMessage } from "../../src/kilo-provider/personal-todo-proposals"

const digest = "a".repeat(64)
const view = {
  proposal: {
    version: 1 as const,
    id: "proposal_11111111-1111-4111-8111-111111111111",
    digest,
    createdAt: 100,
    source: { sessionID: "ses_test", messageID: "msg_test", callID: "call_test" },
    target: { kind: "new" as const, todoID: "todo_22222222-2222-4222-8222-222222222222", baseRevision: 0 as const },
    changes: { title: "Review plan" },
  },
  state: "open" as const,
}

function client(personalTodo: Record<string, (...args: never[]) => unknown>) {
  return { raya: { personalTodo } } as unknown as KiloClient
}

describe("personal Todo proposal extension bridge", () => {
  it("uses the generated list, get, apply, and reject endpoints", async () => {
    const calls: unknown[] = []
    const api = client({
      listProposals: async (input: unknown) => {
        calls.push(["list", input])
        return { data: [view], response: { status: 200 } }
      },
      getProposal: async (input: unknown) => {
        calls.push(["get", input])
        return { data: view, response: { status: 200 } }
      },
      applyProposal: async (input: unknown) => {
        calls.push(["apply", input])
        return { data: { ...view, state: "applied" }, response: { status: 200 } }
      },
      rejectProposal: async (input: unknown) => {
        calls.push(["reject", input])
        return { data: { ...view, state: "rejected" }, response: { status: 200 } }
      },
    })
    const messages: unknown[] = []
    const post = (message: unknown) => messages.push(message)
    const common = { client: api, directory: "C:/work", post }

    await handlePersonalTodoProposalMessage({
      ...common,
      message: { type: "personalTodoProposalList", requestID: "list" },
    })
    await handlePersonalTodoProposalMessage({
      ...common,
      message: { type: "personalTodoProposalGet", requestID: "get", proposalID: view.proposal.id },
    })
    await handlePersonalTodoProposalMessage({
      ...common,
      message: { type: "personalTodoProposalApply", requestID: "apply", proposalID: view.proposal.id, digest },
    })
    await handlePersonalTodoProposalMessage({
      ...common,
      message: { type: "personalTodoProposalReject", requestID: "reject", proposalID: view.proposal.id, digest },
    })

    expect(calls).toEqual([
      ["list", { directory: "C:/work" }],
      ["get", { directory: "C:/work", proposalID: view.proposal.id }],
      ["apply", { directory: "C:/work", proposalID: view.proposal.id, digest }],
      ["reject", { directory: "C:/work", proposalID: view.proposal.id, digest }],
    ])
    expect(messages).toMatchObject([
      { operation: "list", kind: "listed" },
      { operation: "get", kind: "loaded" },
      { operation: "apply", kind: "applied" },
      { operation: "reject", kind: "rejected" },
    ])
  })

  it("reports offline, stale, conflict, and ordinary errors distinctly", async () => {
    const messages: unknown[] = []
    const post = (message: unknown) => messages.push(message)
    await handlePersonalTodoProposalMessage({
      client: null,
      directory: "C:/work",
      message: { type: "personalTodoProposalGet", requestID: "offline", proposalID: view.proposal.id },
      post,
    })
    await handlePersonalTodoProposalMessage({
      client: client({
        applyProposal: async () => ({
          error: {
            name: "PersonalTodoProposalStaleRevisionError",
            data: {
              proposalID: view.proposal.id,
              todoID: view.proposal.target.todoID,
              expected: 1,
              actual: 2,
              message: "Todo changed.",
            },
          },
          response: { status: 409 },
        }),
      }),
      directory: "C:/work",
      message: { type: "personalTodoProposalApply", requestID: "stale", proposalID: view.proposal.id, digest },
      post,
    })
    await handlePersonalTodoProposalMessage({
      client: client({
        rejectProposal: async () => ({
          error: { _tag: "ConflictError", message: "Already applied." },
          response: { status: 409 },
        }),
      }),
      directory: "C:/work",
      message: { type: "personalTodoProposalReject", requestID: "conflict", proposalID: view.proposal.id, digest },
      post,
    })
    await handlePersonalTodoProposalMessage({
      client: client({
        listProposals: async () => ({ error: { message: "Storage failed." }, response: { status: 500 } }),
      }),
      directory: "C:/work",
      message: { type: "personalTodoProposalList", requestID: "error" },
      post,
    })

    expect(messages).toMatchObject([
      { requestID: "offline", kind: "offline" },
      { requestID: "stale", kind: "stale", expected: 1, actual: 2 },
      { requestID: "conflict", kind: "conflict", message: "Already applied." },
      { requestID: "error", kind: "error", message: "Storage failed." },
    ])
  })

  it("reconciles interrupted mutations with one GET and never retries the mutation", async () => {
    const calls: string[] = []
    const applied = client({
      applyProposal: async () => {
        calls.push("apply")
        throw new Error("lost response")
      },
      getProposal: async () => {
        calls.push("get-applied")
        return { data: { ...view, state: "applied" }, response: { status: 200 } }
      },
    })
    const messages: unknown[] = []
    await handlePersonalTodoProposalMessage({
      client: applied,
      directory: "C:/work",
      message: { type: "personalTodoProposalApply", requestID: "applied", proposalID: view.proposal.id, digest },
      post: (message) => messages.push(message),
    })

    const uncertain = client({
      rejectProposal: async () => {
        calls.push("reject")
        throw new Error("lost response")
      },
      getProposal: async () => {
        calls.push("get-open")
        return { data: view, response: { status: 200 } }
      },
    })
    await handlePersonalTodoProposalMessage({
      client: uncertain,
      directory: "C:/work",
      message: { type: "personalTodoProposalReject", requestID: "uncertain", proposalID: view.proposal.id, digest },
      post: (message) => messages.push(message),
    })

    expect(calls).toEqual(["apply", "get-applied", "reject", "get-open"])
    expect(messages).toMatchObject([
      { requestID: "applied", operation: "apply", kind: "applied" },
      { requestID: "uncertain", operation: "reject", kind: "uncertain", item: view },
    ])
  })
})
