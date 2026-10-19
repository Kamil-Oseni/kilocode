import { expect, it } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { loadSessions, type SessionRefreshContext } from "../../src/kilo-provider-utils"

const row: Session = {
  id: "routine",
  slug: "original",
  projectID: "project",
  directory: "/original",
  title: "Original Routine",
  version: "fixture",
  time: { created: 1, updated: 2 },
  metadata: { rayaRoutine: { version: 2, agentID: "worker", runID: "run" } },
}

function fixture() {
  const state = { open: [{ id: row.id, directory: row.directory }], current: true, calls: 0 }
  const sent: unknown[] = []
  const ctx: SessionRefreshContext = {
    connectionState: "connected",
    pendingSessionRefresh: false,
    workspaceDirectory: row.directory,
    sessionDirectories: new Map(),
    listSessions: async () => [],
    openSessions: () => state.open,
    getSession: async () => {
      state.calls++
      return row
    },
    isCurrent: () => state.current,
    postMessage: (message) => sent.push(message),
  }
  return { state, sent, ctx }
}

it("preserves only the explicitly open Routine identity without adding it to ordinary history", async () => {
  const test = fixture()
  await loadSessions(test.ctx)
  expect(test.sent).toEqual([{ type: "sessionsLoaded", sessions: [], preserveSessionIds: [row.id] }])
  expect(test.state.calls).toBe(1)
})

for (const [name, result] of [
  ["known missing", undefined],
  ["archived at zero", { ...row, time: { ...row.time, archived: 0 } }],
  ["foreign ID", { ...row, id: "different" }],
  ["foreign directory", { ...row, directory: "/different" }],
  ["ordinary session", { ...row, metadata: {} }],
] as const)
  it(`does not grant filtered-catalog immunity to a ${name} lookup`, async () => {
    const test = fixture()
    test.ctx.getSession = async () => result
    await loadSessions(test.ctx)
    expect(test.sent).toEqual([{ type: "sessionsLoaded", sessions: [] }])
  })

for (const [name, result] of [
  ["known missing", undefined],
  ["archived at zero", { ...row, time: { ...row.time, archived: 0 } }],
  ["foreign ID", { ...row, id: "different" }],
  ["foreign directory", { ...row, directory: "/different" }],
] as const)
  it(`does not let a failed worktree list override a ${name} direct lookup`, async () => {
    const test = fixture()
    test.ctx.workspaceDirectory = "/workspace"
    test.ctx.sessionDirectories = new Map([
      [row.id, row.directory],
      ["ordinary", row.directory],
    ])
    test.ctx.listSessions = async (dir) => {
      if (dir === row.directory) throw new Error("Worktree list unavailable")
      return []
    }
    test.ctx.getSession = async () => result
    await loadSessions(test.ctx)
    expect(test.sent).toEqual([{ type: "sessionsLoaded", sessions: [], preserveSessionIds: ["ordinary"] }])
  })

it("does not publish a failed-worktree fallback when its open Routine lookup is unknown", async () => {
  const test = fixture()
  test.ctx.workspaceDirectory = "/workspace"
  test.ctx.sessionDirectories = new Map([
    [row.id, row.directory],
    ["ordinary", row.directory],
  ])
  test.ctx.listSessions = async (dir) => {
    if (dir === row.directory) throw new Error("Worktree list unavailable")
    return []
  }
  test.ctx.getSession = async () => {
    throw new Error("Direct lookup unavailable")
  }
  await expect(loadSessions(test.ctx)).rejects.toThrow("Direct lookup unavailable")
  expect(test.sent).toEqual([])
  expect(test.ctx.pendingSessionRefresh).toBe(true)
})

it("retains an actually open ordinary session when only its worktree catalog fails", async () => {
  const test = fixture()
  test.ctx.workspaceDirectory = "/workspace"
  test.ctx.sessionDirectories = new Map([[row.id, row.directory]])
  test.ctx.listSessions = async (dir) => {
    if (dir === row.directory) throw new Error("Worktree list unavailable")
    return []
  }
  test.ctx.getSession = async () => ({ ...row, metadata: {} })
  await loadSessions(test.ctx)
  expect(test.sent).toEqual([{ type: "sessionsLoaded", sessions: [], preserveSessionIds: [row.id] }])
})

it("retains the previous catalog when an omitted lookup has an unknown transport outcome", async () => {
  const test = fixture()
  test.ctx.getSession = async () => {
    throw new Error("HTTP 500 or lost transport")
  }
  await expect(loadSessions(test.ctx)).rejects.toThrow("HTTP 500 or lost transport")
  expect(test.sent).toEqual([])
  expect(test.ctx.pendingSessionRefresh).toBe(true)
})

it("fails an oversized refresh before lookup instead of evicting the sixty-fifth omitted open tab", async () => {
  const test = fixture()
  test.state.open = Array.from({ length: 65 }, (_, index) => ({ id: `routine-${index}`, directory: row.directory }))
  await expect(loadSessions(test.ctx)).rejects.toThrow("Too many open conversations")
  expect(test.sent).toEqual([])
  expect(test.state.calls).toBe(0)
  expect(test.ctx.pendingSessionRefresh).toBe(true)
})

it("withholds a catalog whose pending list predates opening an existing Routine", async () => {
  const test = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Session[]>()
  test.state.open = []
  test.ctx.listSessions = () => {
    entered.resolve()
    return release.promise
  }
  const pending = loadSessions(test.ctx)
  await entered.promise
  test.state.open = [{ id: row.id, directory: row.directory }]
  release.resolve([])
  await pending
  expect(test.sent).toEqual([])
  expect(test.state.calls).toBe(0)
  expect(test.ctx.pendingSessionRefresh).toBe(true)
})

it("does not report overflow from an old catalog after its generation changes", async () => {
  const test = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Session[]>()
  test.state.open = Array.from({ length: 65 }, (_, index) => ({ id: `routine-${index}`, directory: row.directory }))
  test.ctx.listSessions = () => {
    entered.resolve()
    return release.promise
  }
  const pending = loadSessions(test.ctx)
  await entered.promise
  test.state.current = false
  release.resolve([])
  await pending
  expect(test.sent).toEqual([])
  expect(test.state.calls).toBe(0)
  expect(test.ctx.pendingSessionRefresh).toBe(true)
})

for (const control of ["remap", "close", "generation"] as const)
  it(`rechecks the ${control} control after the original omitted lookup yields`, async () => {
    const test = fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Session>()
    test.ctx.getSession = () => {
      entered.resolve()
      return release.promise
    }
    const pending = loadSessions(test.ctx)
    await entered.promise
    if (control === "remap") test.state.open = [{ id: row.id, directory: "/different" }]
    if (control === "close") test.state.open = []
    if (control === "generation") test.state.current = false
    release.resolve(row)
    await pending
    expect(test.sent).toEqual(control === "close" ? [{ type: "sessionsLoaded", sessions: [] }] : [])
    expect(test.ctx.pendingSessionRefresh).toBe(control !== "close")
  })
