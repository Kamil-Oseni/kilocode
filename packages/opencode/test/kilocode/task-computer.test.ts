import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { TaskComputer } from "@/kilocode/tool/task-computer"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { SessionID } from "@/session/schema"
import { GrantID } from "@/kilocode/computer-use/lease"
import type { Desktop } from "@/kilocode/desktop/service"

describe("selected Computer Use child admission", () => {
  it("binds one selected window, preserves it on Resume, and refuses older flat-only hosts", async () => {
    const parent = SessionID.make("session_parent")
    const child = SessionID.make("session_child")
    const target = { version: 1 as const, windowID: "0x222" }
    const identity = "B".repeat(64)
    const calls: string[] = []
    const state = { window: target.windowID, identity, binding: true }
    const desktop: Desktop.Interface = {
      request: (input) =>
        Effect.sync(() => {
          if (input.operation !== "authorize") throw new Error("Unexpected desktop operation")
          calls.push(input.target?.windowID ?? "missing")
          return {
            operation: "authorize" as const,
            decision: "allow" as const,
            reason: "Active selected grant",
            grantID: GrantID.make("grant_selected"),
            windowID: state.window,
            identity: state.identity,
            ...(state.binding ? { binding: { version: 1 as const, windowID: state.window, identity: state.identity } } : {}),
          }
        }),
      list: () => Effect.succeed([]),
      cancelSession: () => Effect.void,
      reply: () => Effect.void,
      reject: () => Effect.void,
    }
    const proof = await Effect.runPromise(TaskComputer.admit({
      access: "computer",
      desktop,
      sessionID: parent,
      parent: {},
      target,
    }))
    if (!proof) throw new Error("Expected a bound Computer Use child")
    const metadata = TaskComputer.bind(TaskAuthority.save({}, "computer"), parent, child, proof)
    expect(TaskAuthority.proof(metadata, child, parent)).toMatchObject({ windowID: target.windowID, identity })
    expect((metadata[TaskAuthority.computerKey] as { version: number }).version).toBe(2)
    expect(calls).toEqual([target.windowID])
    const resumed = { id: child, metadata }
    await Effect.runPromise(TaskComputer.admit({ access: "computer", desktop, sessionID: parent, parent: {}, resumed }))
    expect(calls).toEqual([target.windowID, target.windowID])
    await expect(Effect.runPromise(TaskComputer.admit({ access: "computer", desktop, sessionID: parent, parent: {}, resumed, target: { version: 1, windowID: "0x111" } }))).rejects.toThrow(/cannot be rebound/i)
    expect(calls).toHaveLength(2)
    state.window = "0x111"
    await expect(Effect.runPromise(TaskComputer.admit({ access: "computer", desktop, sessionID: parent, parent: {}, resumed }))).rejects.toThrow()
    state.window = target.windowID
    state.binding = false
    await expect(Effect.runPromise(TaskComputer.admit({ access: "computer", desktop, sessionID: parent, parent: {}, target }))).rejects.toThrow(/versioned binding/i)
    state.binding = true
    state.identity = "invalid"
    await expect(Effect.runPromise(TaskComputer.admit({ access: "computer", desktop, sessionID: parent, parent: {}, target }))).rejects.toThrow(/binding is invalid/i)
  })

  it("denies a nested computer child before it can ask the host for a sibling window", async () => {
    const parent = SessionID.make("session_parent")
    let calls = 0
    const desktop: Desktop.Interface = {
      request: () => { calls++; throw new Error("Host must not be called") },
      list: () => Effect.succeed([]),
      cancelSession: () => Effect.void,
      reply: () => Effect.void,
      reject: () => Effect.void,
    }
    await expect(Effect.runPromise(TaskComputer.admit({
      access: "computer",
      desktop,
      sessionID: parent,
      parent: { metadata: TaskAuthority.save({}, "computer") },
      target: { version: 1, windowID: "0x111" },
    }))).rejects.toThrow(/cannot delegate/i)
    expect(calls).toBe(0)
  })
})
