import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { coordinateNativeRoots, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { StatePublication } from "../../src/agent-manager/state-publication"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raya-host-state-capture-"))
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("actual maintenance gate holds an accepted state write and terminal join until release", async () => {
  await using tmp = await fixture()
  const file = join(tmp.root, ".kilo", "agent-manager.json")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const gate = coordinateNativeRoots([{ kind: "json", path: file }], async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const state = new WorktreeStateManager(tmp.root, () => undefined)
  try {
    state.addSession("accepted", null)
    const close = state.retire()
    expect(state.retire()).toBe(close)
    expect(() => state.addSession("late", null)).toThrow("retired")
    expect(state.publications().roots).toEqual([])
    expect(await Promise.race([close.then(() => "closed"), Promise.resolve("held")])).toBe("held")
    release.resolve()
    await gate
    await close
    const selected = await resolveProfileRoot({ kind: "json", path: file })
    expect(state.publications().roots).toEqual([{ kind: "json", path: selected.path }])
    expect(JSON.parse(await readFile(file, "utf8")).sessions.accepted).toBeDefined()
    expect(Object.isFrozen(state.publications().roots)).toBeTrue()
  } finally {
    release.resolve()
    await Promise.allSettled([gate, state.retire()])
  }
})

test("actual alias rebind refuses a new physical root and retains the old admitted root", async () => {
  await using tmp = await fixture()
  const first = join(tmp.root, "first")
  const second = join(tmp.root, "second")
  const alias = join(tmp.root, "alias")
  await Promise.all([mkdir(first), mkdir(second)])
  await symlink(first, alias, process.platform === "win32" ? "junction" : "dir")
  const owner = new StatePublication(join(alias, "state.json"))
  await owner.run((file) => writeFile(file, "first"))
  const before = owner.snapshot()
  await rm(alias, { recursive: true, force: true })
  await symlink(second, alias, process.platform === "win32" ? "junction" : "dir")
  await expect(owner.run((file) => writeFile(file, "second"))).rejects.toThrow("physical root changed")
  const close = owner.retire()
  await expect(close).rejects.toThrow("retirement failed")
  expect(owner.retire()).toBe(close)
  expect(owner.snapshot()).toEqual(before)
  expect(await readFile(join(first, "state.json"), "utf8")).toBe("first")
})

test("loaded historical contexts retain removed admitted writers without creating cold services", async () => {
  await using tmp = await fixture()
  const item = { id: "owned", root: tmp.root, order: 0, addedAt: "2026-10-01" }
  const registry = new ProjectContexts({
    workspaceRoot: () => undefined,
    enabled: () => true,
    registry: { list: () => [item], get: (id) => (id === item.id ? item : undefined) },
    deps: { log: () => undefined },
  })
  expect(registry.loaded()).toEqual([])
  const first = registry.expand(item.id)!
  first.stateManager().addSession("first", null)
  await first.stateManager().flush()
  await registry.remove(item.id)
  const second = registry.expand(item.id)!
  expect(second.peekState()).toBeUndefined()
  const history = registry.loaded()
  expect(history).toHaveLength(2)
  expect(history[0].generation).not.toBe(history[1].generation)
  expect(history[0].publication?.roots).toHaveLength(1)
  expect(history[1].publication).toBeUndefined()
  expect(Object.isFrozen(history)).toBeTrue()
  expect(Object.isFrozen(history[0])).toBeTrue()
  expect(await registry.captureSnapshot()).toEqual(history)
  expect(second.peekState()).toBeUndefined()
  expect(() => registry.expand(item.id)).toThrow("retired")
})

test("failed native publication keeps its admitted metadata and sticky closure refusal", async () => {
  await using tmp = await fixture()
  const file = join(tmp.root, ".kilo", "agent-manager.json")
  await mkdir(file, { recursive: true })
  const state = new WorktreeStateManager(tmp.root, () => undefined)
  state.addSession("cannot-publish", null)
  await state.flush()
  const selected = await resolveProfileRoot({ kind: "json", path: file })
  expect(state.publications().roots).toEqual([{ kind: "json", path: selected.path }])
  const close = state.retire()
  await expect(close).rejects.toThrow("publication failed")
  expect(state.retire()).toBe(close)
  expect(state.publications().roots).toHaveLength(1)
})
