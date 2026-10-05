import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { ProjectContext } from "../../src/agent-manager/project/context"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raya-worktree-retirement-"))
  await mkdir(join(root, ".kilo"))
  const file = join(root, ".kilo", "agent-manager.json")
  const manager = new WorktreeStateManager(root, () => undefined)
  return { root, file, manager }
}

test("terminal writer joins actual coalesced disk publication and refuses later mutations and recovery", async () => {
  const state = await fixture()
  try {
    state.manager.addSession("accepted-first", null)
    state.manager.addSession("accepted-second", null)
    const retirement = state.manager.retire()
    expect(state.manager.retire()).toBe(retirement)
    expect(() => state.manager.addSession("late", null)).toThrow("retired")
    await expect(state.manager.save()).rejects.toThrow("retired")
    await expect(state.manager.load()).rejects.toThrow("retired")
    await expect(state.manager.prepareRecovery()).rejects.toThrow("retired")
    await retirement
    const data = JSON.parse(await readFile(state.file, "utf8"))
    expect(Object.keys(data.sessions)).toEqual(["accepted-first", "accepted-second"])
    const recovered = new WorktreeStateManager(state.root, () => undefined)
    expect((await recovered.load()).status).toBe("loaded")
    expect(recovered.getSessions().map((item) => item.id)).toEqual(["accepted-first", "accepted-second"])
    await recovered.retire()
  } finally {
    await state.manager.retire().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("retirement joins an admitted actual load and its normalization publication", async () => {
  const state = await fixture()
  try {
    await writeFile(
      state.file,
      JSON.stringify({ worktrees: {}, sessions: { orphan: { worktreeId: "missing", createdAt: "2026-10-01" } } }),
    )
    const load = state.manager.load()
    const retirement = state.manager.retire()
    expect((await load).status).toBe("loaded")
    await retirement
    expect(JSON.parse(await readFile(state.file, "utf8")).sessions).toEqual({})
  } finally {
    await state.manager.retire().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("ordinary save retry can recover a real rename failure while strict retirement retains its raw uncertainty", async () => {
  const state = await fixture()
  try {
    await mkdir(state.file)
    state.manager.addSession("accepted", null)
    await state.manager.flush()
    await rm(state.file, { recursive: true })
    await state.manager.save()
    expect(JSON.parse(await readFile(state.file, "utf8")).sessions.accepted).toBeDefined()
    const retirement = state.manager.retire()
    const result = await retirement.then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) throw new Error("Expected retained publication error")
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.every((err) => err instanceof Error)).toBeTrue()
    await expect(state.manager.retire()).rejects.toBe(result)
  } finally {
    await state.manager.retire().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("strict project close joins held accepted work and still retires the realized writer when work fails", async () => {
  const state = await fixture()
  const context = new ProjectContext("private", state.root, true, { log: () => undefined })
  const owner = context.stateManager()
  await mkdir(state.file)
  owner.addSession("accepted", null)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const error = new Error("Owned accepted operation failed")
  const job = context.run(async () => {
    started.resolve()
    await release.promise
    throw error
  })
  const observed = job.catch((err: unknown) => err)
  await started.promise
  const retirement = context.captureClose()
  const joined = retirement.catch((err: unknown) => err)
  try {
    expect(context.captureClose()).toBe(retirement)
    expect(() => owner.addSession("late", null)).toThrow("retired")
    expect(() => context.stateManager()).toThrow("retired")
    expect(await Promise.race([joined, Promise.resolve("held")])).toBe("held")
    release.resolve()
    expect(await observed).toBe(error)
    const result = await joined
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) throw new Error("Expected strict capture failure")
    expect(result.errors).toContain(error)
    expect(result.errors.some((item) => item instanceof AggregateError)).toBeTrue()
    expect(context.lifecycle).toBe("disposing")
    await expect(owner.retire()).rejects.toBeInstanceOf(AggregateError)
  } finally {
    release.resolve()
    await Promise.allSettled([observed, joined, owner.retire()])
    await rm(state.root, { recursive: true, force: true })
  }
})

test("cold project strict close never constructs unused repository owners", async () => {
  const state = await fixture()
  const context = new ProjectContext("cold", state.root, true, { log: () => undefined })
  try {
    await context.captureClose()
    expect(context.loaded).toBeFalse()
    expect(context.peekState()).toBeUndefined()
    expect(context.peekWorktrees()).toBeUndefined()
    expect(context.peekSetup()).toBeUndefined()
    expect(() => context.stateManager()).toThrow("retired")
    expect(() => context.worktreeManager()).toThrow("retired")
    expect(() => context.setupService()).toThrow("retired")
    expect(context.lifecycle).toBe("disposed")
  } finally {
    await rm(state.root, { recursive: true, force: true })
  }
})
