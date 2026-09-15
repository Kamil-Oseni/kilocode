import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import { PersonalTodoReminderCoordinator } from "../../src/services/personal-todo-reminders"

const reminder = {
  version: 1 as const,
  state: "claimed" as const,
  deliveryID: "delivery-1",
  claimID: "claim-1",
  todoID: "todo-1",
  todoRevision: 2,
  reminderRevision: 3,
  title: "Review accounts",
  reminderAt: 1,
  claimedAt: 2,
  claimExpiresAt: 3,
}

type Reminder = typeof reminder

function setup(options?: {
  state?: ConnectionState
  items?: Reminder[]
  claim?: () => Promise<Reminder[]>
  show?: () => Promise<string | undefined>
}) {
  const calls: unknown[] = []
  const polls: Array<() => void> = []
  const listeners = new Set<(state: ConnectionState) => void>()
  const api = {
    raya: {
      personalTodo: {
        reminders: async () => {
          calls.push(["reminders"])
          const data = options?.claim ? await options.claim() : (options?.items ?? [reminder])
          return { data, response: { status: 200 } }
        },
        acknowledgeReminder: async (input: unknown) => {
          calls.push(["acknowledge", input])
          return { data: { ...reminder, state: "acknowledged" }, response: { status: 200 } }
        },
      },
    },
  } as unknown as KiloClient
  const state = { value: options?.state ?? ("connected" as ConnectionState) }
  const connection = {
    getClient: () => api,
    getConnectionState: () => state.value,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const ui = {
    show: (message: string, action: string) => {
      calls.push(["show", message, action])
      return options?.show ? options.show() : Promise.resolve(undefined)
    },
    execute: async (command: string) => {
      calls.push(["execute", command])
    },
    schedule: (callback: () => void, delay: number) => {
      calls.push(["schedule", delay])
      polls.push(callback)
      return { dispose: () => calls.push(["dispose-timer"]) }
    },
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const change = (next: ConnectionState) => {
    state.value = next
    for (const listener of listeners) listener(next)
  }
  return { calls, change, connection, flush, listeners, polls, ui }
}

describe("personal todo reminder coordinator", () => {
  it("acknowledges exact claim IDs without waiting for the notification choice", async () => {
    const choice = new Promise<string | undefined>(() => undefined)
    const ctx = setup({ show: () => choice })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()

    expect(ctx.calls).toEqual([
      ["schedule", 60_000],
      ["reminders"],
      ["show", "Todo reminder: Review accounts", "Open Todo"],
      ["acknowledge", { deliveryID: "delivery-1", claimID: "claim-1" }],
    ])
    coordinator.dispose()
  })

  it("dispatches and acknowledges every claim without waiting for choices", async () => {
    const next = { ...reminder, deliveryID: "delivery-2", claimID: "claim-2", todoID: "todo-2", title: "Pay bill" }
    const choice = new Promise<string | undefined>(() => undefined)
    const ctx = setup({ items: [reminder, next], show: () => choice })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()

    expect(ctx.calls.filter(([name]) => name === "show")).toHaveLength(2)
    expect(ctx.calls.filter(([name]) => name === "acknowledge")).toEqual([
      ["acknowledge", { deliveryID: "delivery-1", claimID: "claim-1" }],
      ["acknowledge", { deliveryID: "delivery-2", claimID: "claim-2" }],
    ])
    coordinator.dispose()
  })

  it("defers an overlapping reminders request until the active claim finishes", async () => {
    let release!: (items: Reminder[]) => void
    const claimed = new Promise<Reminder[]>((done) => (release = done))
    const ctx = setup({ claim: () => claimed })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()
    ctx.polls[0]()
    await ctx.flush()

    expect(ctx.calls.filter(([name]) => name === "reminders")).toHaveLength(1)
    release([])
    await ctx.flush()
    expect(ctx.calls.filter(([name]) => name === "reminders")).toHaveLength(2)
    coordinator.dispose()
  })

  it("does not acknowledge a synchronously failed presentation", async () => {
    const ctx = setup({
      show: () => {
        throw new Error("private reminder title")
      },
    })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()

    expect(ctx.calls.filter(([name]) => name === "acknowledge")).toEqual([])
    coordinator.dispose()
  })

  it("acknowledges a dispatched notification whose choice later rejects", async () => {
    const ctx = setup({ show: () => Promise.reject(new Error("private reminder title")) })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()

    expect(ctx.calls.filter(([name]) => name === "acknowledge")).toHaveLength(1)
    coordinator.dispose()
  })

  it("routes the Open Todo choice through the registered command", async () => {
    const ctx = setup({ show: async () => "Open Todo" })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    await ctx.flush()

    expect(ctx.calls).toContainEqual(["execute", "raya.todosButtonClicked"])
    coordinator.dispose()
  })

  it("starts on connection and cleans up its timer and subscription", async () => {
    const ctx = setup({ state: "disconnected" })
    const coordinator = new PersonalTodoReminderCoordinator(ctx.connection, ctx.ui)
    expect(ctx.calls).toEqual([])

    ctx.change("connected")
    await ctx.flush()
    coordinator.dispose()

    expect(ctx.calls).toContainEqual(["schedule", 60_000])
    expect(ctx.calls).toContainEqual(["dispose-timer"])
    expect(ctx.listeners.size).toBe(0)
  })
})
