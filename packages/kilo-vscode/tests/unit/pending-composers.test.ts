import { expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { Window } from "happy-dom"
import { createPendingComposers } from "../../webview-ui/agent-manager/pending-composers"
import { createProjectStore } from "../../webview-ui/agent-manager/project/store"
import { DurableDrafts } from "../../webview-ui/src/utils/durable-drafts"
import type { AddSessionToWorktreeRequest } from "../../webview-ui/src/types/messages"
import type { ComposerDraftExtensionMessage, DraftEntry } from "../../src/shared/composer-drafts-messages"

it("discovers owned pending tabs and applies only the exact reordered creation receipt", async () => {
  const dom = new Window()
  const window = Object.getOwnPropertyDescriptor(globalThis, "window")
  const event = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent")
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom })
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: dom.CustomEvent })
  let receive!: (message: ComposerDraftExtensionMessage) => void
  const entry: DraftEntry = {
    identity: { box: "agent-manager:known", key: "opaque", pendingID: "saved", workspace: "private" },
    token: { generation: crypto.randomUUID(), revision: 1 },
    content: { text: "Retained draft", comments: [], images: [], scroll: 0 },
    mutation: "save",
    digest: "a".repeat(64),
  }
  const lists: string[] = []
  const durable = new DurableDrafts({
    onMessage: (handler) => {
      receive = handler
      return () => {}
    },
    postMessage: (message) => {
      if (message.type !== "composerDraftList") return
      lists.push(message.owner)
      queueMicrotask(() =>
        receive({ ...message, type: "composerDraftResult", operation: "composerDraftList", entries: [entry] }),
      )
    },
  })
  const posts: AddSessionToWorktreeRequest[] = []
  const applied: unknown[] = []
  dom.addEventListener("agentManagerApplyDraft", (event) => applied.push((event as CustomEvent).detail))
  let dispose!: () => void
  try {
    const state = createRoot((stop) => {
      dispose = stop
      const [selection, select] = createSignal<string | undefined>("known")
      const [active, setActive] = createSignal<string | undefined>()
      const store = createProjectStore("project")
      const pending = createPendingComposers({
        local: "local",
        selection,
        durable,
        title: () => "New session",
        store: () => store,
        setActive,
        add: (id) => store.tabs.set((ids) => [...ids, id]),
        clear: () => {},
        blur: () => {},
        post: (message) => posts.push(message),
      })
      return { pending, select, active }
    })
    await Promise.resolve()
    receive({
      type: "composerDraftState",
      epoch: durable.epoch,
      generation: 1,
      connected: true,
      owners: [{ box: "agent-manager:known", owner: "owner-a" }],
    })
    const deadline = performance.now() + 1000
    while (state.pending.sessions(() => []).length === 0 && performance.now() < deadline) await Bun.sleep(1)
    expect(lists).toEqual(["owner-a"])
    expect(state.pending.sessions(() => []).map((tab) => tab.id)).toEqual(["saved"])
    dom.dispatchEvent(
      new dom.CustomEvent("composerDraftRecovered", {
        detail: { box: "agent-manager:known", owner: "foreign", pendingID: "foreign" },
      }),
    )
    expect(state.pending.sessions(() => []).map((tab) => tab.id)).toEqual(["saved"])
    dom.dispatchEvent(
      new dom.CustomEvent("composerDraftRecovered", {
        detail: { box: "agent-manager:known", owner: "owner-a", pendingID: "recovered" },
      }),
    )
    expect(state.active()).toBe("recovered")
    state.pending.remove("saved")
    expect(state.pending.sessions(() => []).map((tab) => tab.id)).toEqual(["recovered"])
    dom.dispatchEvent(new dom.CustomEvent("newTaskRequest"))
    dom.dispatchEvent(new dom.CustomEvent("newTaskRequest"))
    expect(posts).toHaveLength(2)
    state.pending.apply({ worktreeId: "known", sessionId: "imported" })
    expect(applied).toHaveLength(0)
    state.pending.apply({ worktreeId: "known", sessionId: "second", requestID: posts[1].requestID })
    state.pending.apply({ worktreeId: "known", sessionId: "first", requestID: posts[0].requestID })
    expect(applied).toEqual([
      { id: posts[1].requestID, sessionId: "second", boxId: "agent-manager:known", owner: "owner-a" },
      { id: posts[0].requestID, sessionId: "first", boxId: "agent-manager:known", owner: "owner-a" },
    ])
    state.select("local")
    expect(
      state.pending.active(
        () => [],
        () => [],
      ),
    ).toEqual([])
  } finally {
    dispose?.()
    durable.dispose()
    if (window) Object.defineProperty(globalThis, "window", window)
    if (!window) Reflect.deleteProperty(globalThis, "window")
    if (event) Object.defineProperty(globalThis, "CustomEvent", event)
    if (!event) Reflect.deleteProperty(globalThis, "CustomEvent")
    dom.happyDOM.cancelAsync()
  }
})
