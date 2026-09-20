import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  availableSubagents,
  createSubagentTabs,
  restoreSubagents,
  type SubagentState,
} from "../../webview-ui/agent-manager/subagent-tabs"

function scene() {
  const [current] = createSignal<string | undefined>("parent")
  const calls = {
    synced: [] as Array<[string, string | undefined]>,
    unsynced: [] as string[],
    shown: 0,
    hidden: 0,
  }
  const tabs = createSubagentTabs({
    current,
    sync: (id, parent) => calls.synced.push([id, parent]),
    unsync: (id) => calls.unsynced.push(id),
    show: () => calls.shown++,
    hide: () => calls.hidden++,
  })
  return { tabs, calls }
}

describe("Agent Manager subagent tabs", () => {
  it("opens multiple child sessions and syncs each to its parent", () => {
    createRoot((dispose) => {
      const item = scene()
      item.tabs.open("child-1", "First", "parent-1")
      item.tabs.open("child-2", "Second", "parent-2")

      expect(item.tabs.tabs()).toEqual([
        { id: "child-1", title: "First", parentID: "parent-1" },
        { id: "child-2", title: "Second", parentID: "parent-2" },
      ])
      expect(item.tabs.active()).toBe("child-2")
      expect(item.calls.synced).toEqual([
        ["child-1", "parent-1"],
        ["child-2", "parent-2"],
      ])
      expect(item.calls.shown).toBe(2)
      dispose()
    })
  })

  it("closes the active tab onto its nearest survivor and hides when empty", () => {
    createRoot((dispose) => {
      const item = scene()
      item.tabs.open("one", "One")
      item.tabs.open("two", "Two")
      item.tabs.open("three", "Three")

      item.tabs.close("two")
      expect(item.tabs.tabs().map((tab) => tab.id)).toEqual(["one", "three"])
      expect(item.tabs.active()).toBe("three")

      item.tabs.close("three")
      item.tabs.close("one")
      expect(item.tabs.tabs()).toEqual([])
      expect(item.tabs.active()).toBeUndefined()
      expect(item.calls.unsynced).toEqual(["two", "three", "one"])
      expect(item.calls.hidden).toBe(1)
      dispose()
    })
  })

  it("adds missing parent context without replacing the original parent", () => {
    createRoot((dispose) => {
      const item = scene()
      item.tabs.open("child", "Initial")
      item.tabs.open("child", "Renamed", "parent")
      item.tabs.open("child", "Changed again", "different-parent")

      expect(item.tabs.tabs()).toEqual([{ id: "child", title: "Changed again", parentID: "parent" }])
      expect(item.calls.synced).toEqual([["child", "parent"]])
      dispose()
    })
  })

  it("supports Close Others and preserves the selected child", () => {
    createRoot((dispose) => {
      const item = scene()
      item.tabs.open("one")
      item.tabs.open("two")
      item.tabs.open("three")

      item.tabs.closeOthers("one")
      expect(item.tabs.tabs().map((tab) => tab.id)).toEqual(["one"])
      expect(item.tabs.active()).toBe("one")
      expect(item.calls.unsynced).toEqual(["two", "three"])
      expect(item.calls.shown).toBe(4)
      dispose()
    })
  })

  it("reorders tabs without changing the active child", () => {
    createRoot((dispose) => {
      const item = scene()
      item.tabs.open("one")
      item.tabs.open("two")
      item.tabs.open("three")
      item.tabs.select("two")

      item.tabs.reorder("three", "one")
      expect(item.tabs.tabs().map((tab) => tab.id)).toEqual(["three", "one", "two"])
      expect(item.tabs.active()).toBe("two")
      dispose()
    })
  })

  it("keeps tabs and active children separate for each context", () => {
    createRoot((dispose) => {
      const [context, setContext] = createSignal("worktree-a")
      const calls = {
        synced: [] as Array<[string, string | undefined]>,
        unsynced: [] as string[],
        shown: 0,
        hidden: 0,
      }
      const item = createSubagentTabs({
        current: () => "parent",
        context: () => context(),
        sync: (id, parent) => calls.synced.push([id, parent]),
        unsync: (id) => calls.unsynced.push(id),
        show: () => calls.shown++,
        hide: () => calls.hidden++,
      })

      item.open("child-a", "A", "parent-a")
      setContext("worktree-b")
      item.open("child-b", "B", "parent-b")

      expect(item.tabs().map((tab) => tab.id)).toEqual(["child-b"])
      expect(item.active()).toBe("child-b")
      setContext("worktree-a")
      expect(item.tabs().map((tab) => tab.id)).toEqual(["child-a"])
      expect(item.active()).toBe("child-a")
      expect(calls.synced).toEqual([
        ["child-a", "parent-a"],
        ["child-b", "parent-b"],
      ])
      dispose()
    })
  })

  it("restores twelve child tabs, the selected child, and exact parent sync after restart", () => {
    const state: SubagentState = {
      version: 1,
      tabs: {
        "single:parent": Array.from({ length: 12 }, (_, index) => ({
          id: `child-${index + 1}`,
          title: `Worker ${index + 1}`,
          parentID: "parent",
        })),
      },
      active: { "single:parent": "child-7" },
    }
    createRoot((dispose) => {
      const calls: Array<[string, string | undefined]> = []
      const tabs = createSubagentTabs({
        current: () => "parent",
        context: (parent) => `single:${parent ?? "parent"}`,
        initial: state,
        sync: (id, parent) => calls.push([id, parent]),
        unsync: () => undefined,
        show: () => undefined,
        hide: () => undefined,
      })

      expect(tabs.tabs()).toHaveLength(12)
      expect(tabs.active()).toBe("child-7")
      expect(calls).toEqual(state.tabs["single:parent"].map((tab) => [tab.id, "parent"]))
      dispose()
    })
  })

  it("persists a bounded restart record and rejects malformed selected children", () => {
    const writes: SubagentState[] = []
    createRoot((dispose) => {
      const tabs = createSubagentTabs({
        current: () => "parent",
        initial: { version: 1, tabs: { default: [{ id: "kept", title: "Kept" }] }, active: { default: "lost" } },
        persist: (state) => writes.push(structuredClone(state)),
        sync: () => undefined,
        unsync: () => undefined,
        show: () => undefined,
        hide: () => undefined,
      })

      expect(tabs.tabs()).toEqual([{ id: "kept", title: "Kept" }])
      expect(tabs.active()).toBeUndefined()
      tabs.open("next", "Next", "parent")
      tabs.select("kept")
      expect(writes.at(-1)).toEqual({
        version: 1,
        tabs: {
          default: [
            { id: "kept", title: "Kept" },
            { id: "next", title: "Next", parentID: "parent" },
          ],
        },
        active: { default: "kept" },
      })
      dispose()
    })

    expect(restoreSubagents({ version: 2, tabs: {}, active: {} })).toEqual({ version: 1, tabs: {}, active: {} })
    expect(
      restoreSubagents({
        version: 1,
        tabs: { default: [{ id: "same", title: "First" }, { id: "same", title: "Duplicate" }, { id: 3 }] },
        active: { default: "missing" },
      }),
    ).toEqual({ version: 1, tabs: { default: [{ id: "same", title: "First" }] }, active: {} })
  })

  it("finds direct subagent sessions in task tool parts", () => {
    const tabs = availableSubagents([
      {
        id: "task-1",
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Inspect files", subagent_type: "explore" },
          output: "",
          title: "",
        },
        metadata: { sessionId: "child-1", displayName: "Map API routes · Explore" },
      },
      {
        id: "task-2",
        type: "tool",
        tool: "task",
        state: { status: "running", input: { subagent_type: "general" } },
        metadata: { sessionId: "child-2" },
      },
    ])

    expect(tabs).toEqual([
      { id: "child-1", title: "Map API routes · Explore" },
      { id: "child-2", title: "general" },
    ])
  })
})
