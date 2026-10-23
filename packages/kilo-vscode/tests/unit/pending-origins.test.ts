import { expect, test } from "bun:test"
import { pendingOrigins } from "../../webview-ui/src/utils/pending-origins"
import type { DraftEntry, DraftTarget } from "../../src/shared/composer-drafts-messages"

function fixture() {
  const state = { owner: "original" }
  const id = "sidebar-pending:original"
  const entries: DraftEntry[] = ["sidebar:new-task", "sidebar:fallback"].map((box, index) => ({
    identity: { workspace: "C:/mapped", box, key: `${box}:opaque-original-${index}`, pendingID: id },
    token: { generation: crypto.randomUUID(), revision: 1 },
    content: { text: index ? "Second 二番" : "First 一番", comments: [], images: [], scroll: 0 },
    mutation: "original",
    digest: "a".repeat(64),
  }))
  const stored = new Set(entries.map((row) => row.identity.key))
  const routing = pendingOrigins({
    owner: () => state.owner,
    view: (target: DraftTarget) => ({
      owner: state.owner,
      stored: stored.has(target.key),
      locked: false,
      content: { text: "", comments: [], images: [], scroll: 0 },
      loaded: true,
      error: undefined,
      revision: 0,
    }),
  })
  return { state, id, entries, stored, routing }
}
test("exact original keys are distinct UI choices without rekeying the shared pending identity", () => {
  const state = fixture()
  state.routing.record(state.entries)
  expect(state.routing.target(state.id)).toBeUndefined()
  const choices = state.routing.choices(state.id)
  expect(choices).toHaveLength(2)
  expect(choices[0].id).not.toContain('"')
  expect(state.routing.choose(state.id, choices[1].id)).toBe(true)
  expect(state.routing.target(state.id)).toMatchObject({
    box: "sidebar:fallback",
    key: state.entries[1].identity.key,
    pendingID: state.id,
  })
  state.stored.delete(state.entries[1].identity.key)
  expect(state.routing.target(state.id)).toBeUndefined()
  expect(state.routing.choices(state.id)).toHaveLength(1)
  expect(state.routing.choose(state.id, choices[0].id)).toBe(true)
  expect(state.routing.target(state.id)?.key).toBe(state.entries[0].identity.key)
})
test("promotion retains its original box and leaves the sibling pending without choosing it", () => {
  const state = fixture()
  state.routing.record(state.entries)
  const selected = state.routing.choices(state.id)[1]
  state.routing.choose(state.id, selected.id)
  state.routing.created(state.id, "session-original")
  expect(state.routing.source(state.id, "session-original")?.key).toBe(state.entries[1].identity.key)
  expect(state.routing.target("session-original")).toEqual({
    box: "sidebar:fallback",
    key: "sidebar:fallback:session:session-original",
    sessionID: "session-original",
  })
  expect(state.routing.pending()).toEqual([state.id])
  expect(state.routing.target(state.id)).toBeUndefined()
  expect(state.routing.choices(state.id)[0].target.key).toBe(state.entries[0].identity.key)
  state.routing.created(state.id, "session-original")
  expect(state.routing.source(state.id, "session-original")?.box).toBe("sidebar:fallback")
})
test("replaced ownership cannot hydrate old originals and fresh inventory is admitted explicitly", () => {
  const state = fixture()
  state.routing.record([state.entries[0]])
  expect(state.routing.target(state.id)?.key).toBe(state.entries[0].identity.key)
  state.state.owner = "replacement"
  expect(state.routing.target(state.id)).toBeUndefined()
  expect(state.routing.pending()).toEqual([])
  state.routing.record([state.entries[1]])
  expect(state.routing.target(state.id)?.key).toBe(state.entries[1].identity.key)
})
