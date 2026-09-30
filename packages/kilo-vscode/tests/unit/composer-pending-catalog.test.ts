import { expect, it } from "bun:test"
import { createNewTaskDrafts, pendingCatalog } from "../../webview-ui/agent-manager/new-task-drafts"
import { Window } from "happy-dom"
import type { DraftEntry } from "../../src/shared/composer-drafts-messages"

it("discovers pending tabs only from explicit canonical identity and active content", () => {
  const entry: DraftEntry = {
    identity: { box: "agent-manager:local", key: "opaque:key:unrelated", workspace: "private", pendingID: "pending" },
    token: { generation: "4c4b325c-768d-451a-8aa2-c361772fcb55", revision: 1 },
    content: { text: "saved", comments: [], images: [], scroll: 0 },
    mutation: "save",
    digest: "a".repeat(64),
  }
  expect(
    pendingCatalog(
      [
        entry,
        entry,
        { ...entry, content: null },
        { ...entry, identity: { ...entry.identity, box: "other", pendingID: "foreign" } },
        {
          ...entry,
          identity: {
            ...entry.identity,
            pendingID: undefined,
            sessionID: "session",
            key: "agent-manager:local:pending:fake",
          },
        },
      ],
      "agent-manager:local",
    ),
  ).toEqual(["pending"])
})

it("keeps temporary worktree drafts distinct across restart and refuses a different owner apply", () => {
  const dom = new Window()
  const window = Object.getOwnPropertyDescriptor(globalThis, "window")
  const event = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent")
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom })
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.CustomEvent })
  const first = createNewTaskDrafts()
  const restarted = createNewTaskDrafts()
  const events: unknown[] = []
  dom.addEventListener("agentManagerApplyDraft", (event) => events.push((event as CustomEvent).detail))
  try {
    const a = first.create("same-worktree", "owner-a")
    const b = restarted.create("same-worktree", "owner-a")
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^[a-f0-9-]{36}$/)
    first.apply("same-worktree", "session-b", "owner-b", a.id)
    expect(events).toHaveLength(0)
    const c = first.create("same-worktree", "owner-a")
    first.apply("same-worktree", "imported-session", "owner-a")
    first.apply("same-worktree", "unknown-session", "owner-a", b.id)
    expect(events).toHaveLength(0)
    first.apply("same-worktree", "session-c", "owner-a", c.id)
    first.apply("same-worktree", "session-a", "owner-a", a.id)
    first.apply("same-worktree", "duplicate-event", "owner-a", a.id)
    expect(events).toEqual([
      { id: c.id, sessionId: "session-c", boxId: "agent-manager:same-worktree", owner: "owner-a" },
      { id: a.id, sessionId: "session-a", boxId: "agent-manager:same-worktree", owner: "owner-a" },
    ])
  } finally {
    first.cleanup()
    restarted.cleanup()
    if (window) Object.defineProperty(globalThis, "window", window)
    if (!window) Reflect.deleteProperty(globalThis, "window")
    if (event) Object.defineProperty(globalThis, "CustomEvent", event)
    if (!event) Reflect.deleteProperty(globalThis, "CustomEvent")
    dom.happyDOM.cancelAsync()
  }
})
