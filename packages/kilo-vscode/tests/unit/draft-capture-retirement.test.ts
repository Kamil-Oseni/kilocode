import { expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RoutineDrafts } from "../../src/kilo-provider/routine-drafts"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-draft-retirement-"))
  const file = path.join(root, "draft.json")
  const row = { owner: "owner", conversationID: "conversation", revision: 0, draft: "", attachments: [] }
  await writeFile(file, JSON.stringify(row))
  const entered = deferred()
  const release = deferred()
  const drafts = new RoutineDrafts()
  drafts.mount("pane", {
    agentID: "agent",
    owner: row.owner,
    conversationID: row.conversationID,
    revision: 0,
    current: () => true,
    read: async () => JSON.parse(await readFile(file, "utf8")),
    write: async (draft, ids, revision) => {
      const prior = JSON.parse(await readFile(file, "utf8"))
      if (prior.revision !== revision) throw new Error("Publication revision changed")
      entered.resolve()
      await release.promise
      const next = { ...prior, draft, attachments: ids.map((id) => ({ id })), revision: revision + 1 }
      await writeFile(file + ".tmp", JSON.stringify(next))
      await rename(file + ".tmp", file)
      return next
    },
  })
  const identity = { agentID: "agent", owner: row.owner, conversationID: row.conversationID }
  return { root, file, drafts, entered, release, identity }
}

test("terminal Routine fence joins the actual held atomic publisher and refuses later pane, edit and send admissions", async () => {
  const state = await fixture()
  try {
    const save = state.drafts.flush(
      "pane",
      state.identity,
      { cutoff: 1, draft: "café 日本語 😀", attachmentIDs: [] },
      Date.now() + 5000,
    )
    await state.entered.promise
    const close = state.drafts.captureClose()
    expect(state.drafts.captureClose()).toBe(close)
    let settled = false
    void close.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => state.drafts.send("pane", state.identity)).toThrow("retired")
    expect(() =>
      state.drafts.issue({ paneID: "pane", ...state.identity, expectedRevision: 0, sequence: 2, draft: "late" }),
    ).toThrow("retired")
    expect(() =>
      state.drafts.mount("late", {
        ...state.identity,
        revision: 0,
        current: () => true,
        read: async () => undefined,
        write: async () => undefined,
      }),
    ).toThrow("retired")
    state.release.resolve()
    await save
    await close
    expect(JSON.parse(await readFile(state.file, "utf8"))).toMatchObject({ draft: "café 日本語 😀", revision: 1 })
  } finally {
    state.release.resolve()
    await state.drafts.captureClose().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("final Routine capture requires correlated mounted-view snapshot and actual durable publisher ACK", async () => {
  const state = await fixture()
  const sent: Parameters<Parameters<RoutineDrafts["prepare"]>[1]>[0][] = []
  const prepare = state.drafts.prepare(Date.now() + 5000, (msg) => sent.push(msg))
  const request = sent[0]!
  try {
    state.drafts.confirmCapture("wrong", "pane", { ...state.identity, revision: 0 })
    expect(await Promise.race([prepare.then(() => "closed"), Promise.resolve("held")])).toBe("held")
    const save = state.drafts.flush(
      "pane",
      state.identity,
      { cutoff: 1, draft: "Final café 日本語 😀", attachmentIDs: [] },
      Date.now() + 5000,
    )
    await state.entered.promise
    state.release.resolve()
    const proof = await save
    state.drafts.confirmCapture(request.requestID, "pane", proof)
    await prepare
    await state.drafts.captureClose()
    expect(JSON.parse(await readFile(state.file, "utf8"))).toMatchObject({ draft: "Final café 日本語 😀", revision: 1 })
  } finally {
    state.release.resolve()
    await Promise.allSettled([prepare, state.drafts.captureClose()])
    await rm(state.root, { recursive: true, force: true })
  }
})

test("missing final Routine view acknowledgement is a sticky capture refusal", async () => {
  const state = await fixture()
  try {
    await expect(state.drafts.prepare(Date.now() + 30, () => undefined)).rejects.toThrow("final draft flush failed")
    await expect(state.drafts.captureClose()).rejects.toThrow("capture closure failed")
  } finally {
    state.release.resolve()
    await state.drafts.captureClose().catch((err) => expect(err).toBeInstanceOf(AggregateError))
    await rm(state.root, { recursive: true, force: true })
  }
})

test("a deadline refusal retains the real publisher until it settles, then capture keeps the original failure", async () => {
  const state = await fixture()
  try {
    const save = state.drafts.flush(
      "pane",
      state.identity,
      { cutoff: 1, draft: "persist despite timeout", attachmentIDs: [] },
      Date.now() + 50,
    )
    await state.entered.promise
    await expect(save).rejects.toThrow("timed out")
    const close = state.drafts.captureClose()
    let settled = false
    void close.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    state.release.resolve()
    await expect(close).rejects.toThrow("capture closure failed")
    expect(state.drafts.captureClose()).toBe(close)
    expect(JSON.parse(await readFile(state.file, "utf8"))).toMatchObject({
      draft: "persist despite timeout",
      revision: 1,
    })
  } finally {
    state.release.resolve()
    await state.drafts.captureClose().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("a real publication failure stays joined after its mounted pane is removed", async () => {
  const state = await fixture()
  try {
    const save = state.drafts.flush(
      "pane",
      state.identity,
      { cutoff: 1, draft: "refused", attachmentIDs: [] },
      Date.now() + 5000,
    )
    await state.entered.promise
    state.drafts.unmount("pane", "agent")
    const close = state.drafts.captureClose()
    await rm(state.file)
    await mkdir(state.file)
    const failed = save.then(
      () => undefined,
      (err: unknown) => err,
    )
    const retired = close.then(
      () => undefined,
      (err: unknown) => err,
    )
    state.release.resolve()
    expect(await failed).toMatchObject({ code: process.platform === "win32" ? "EPERM" : "EISDIR" })
    expect(await retired).toBeInstanceOf(AggregateError)
    expect(state.drafts.captureClose()).toBe(close)
  } finally {
    state.release.resolve()
    await state.drafts.captureClose().catch(() => undefined)
    await rm(state.root, { recursive: true, force: true })
  }
})

test("terminal loaded project registry closes actual state and never constructs an unused project owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-project-retirement-"))
  const registry = new ProjectContexts({
    workspaceRoot: () => root,
    enabled: () => false,
    registry: { list: () => [], get: () => undefined },
    deps: { log: () => undefined },
  })
  try {
    const context = registry.pinned()!
    const state = context.stateManager()
    const save = state.save()
    const close = registry.captureClose()
    expect(registry.captureClose()).toBe(close)
    await save
    await close
    expect(() => state.save()).toThrow("retired")
    expect(() => registry.pinned()).toThrow("retired")
    expect([...registry.values()]).toEqual([context])
    const cold = new ProjectContexts({
      workspaceRoot: () => root,
      enabled: () => false,
      registry: { list: () => [], get: () => undefined },
      deps: {
        log: () => undefined,
        state: () => {
          throw new Error("Unused factory called")
        },
      },
    })
    await cold.captureClose()
    expect([...cold.values()]).toEqual([])
    expect(() => cold.pinned()).toThrow("retired")
  } finally {
    await registry.captureClose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test("terminal composer joins an admitted production Storage save and refuses later host requests", async () => {
  const { ComposerDrafts } = await import("../../src/kilo-provider/composer-drafts")
  const { draftStorage } = await import("../fixtures/durable-draft-storage")
  await using store = await draftStorage()
  const entered = deferred()
  const release = deferred()
  const base = { epoch: "pane", generation: 1, owner: "owner", requestID: "request" }
  const call = async (request: import("../../src/shared/composer-drafts-messages").ComposerDraftRequest) => {
    const result = await store.handle(request)
    if (result.error) throw new Error(result.error)
    return result
  }
  const backend: import("../../src/kilo-provider/composer-drafts").DraftBackend = {
    list: async (scope) => ({
      entries: (await call({ ...base, type: "composerDraftList", box: scope.box })).entries ?? [],
    }),
    load: async (identity) => ({ entry: (await call({ ...base, type: "composerDraftLoad", identity })).entry ?? null }),
    save: async (identity, expected, content, mutation) => {
      entered.resolve()
      await release.promise
      const result = await call({ ...base, type: "composerDraftSave", identity, expected, content, mutation })
      if (!result.entry) throw new Error("Missing actual committed draft")
      return { entry: result.entry }
    },
    clear: async (identity, expected, mutation) => {
      const result = await call({ ...base, type: "composerDraftClear", identity, expected, mutation })
      if (!result.entry) throw new Error("Missing committed tombstone")
      return { entry: result.entry }
    },
    promote: async (from, to, source, target, mutation) => {
      const result = await call({ ...base, type: "composerDraftPromote", from, to, source, target, mutation })
      if (!result.source || !result.target) throw new Error("Missing committed promotion")
      return { source: result.source, target: result.target }
    },
  }
  const controller = new ComposerDrafts({
    backend: () => backend,
    scope: async (target) => ({ ...target, workspace: store.root }),
    owners: () => [{ box: "prompt:default", owner: "owner" }],
    generation: () => 1,
    post: () => undefined,
    message: async () => undefined,
  })
  const identity = { workspace: store.root, box: "prompt:default", key: "prompt:default:pending:one", pendingID: "one" }
  try {
    await controller.handle({ type: "composerDraftPane", epoch: "pane", active: true })
    const save = controller.handle({
      ...base,
      type: "composerDraftSave",
      identity,
      mutation: "owned-save",
      content: { text: "Exact café 日本語 😀", comments: [], images: [], scroll: 0 },
    })
    await entered.promise
    const close = controller.captureClose()
    expect(controller.captureClose()).toBe(close)
    let settled = false
    void close.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(controller.handle({ type: "composerDraftPane", epoch: "late", active: true })).rejects.toThrow(
      "retired",
    )
    release.resolve()
    await save
    await close
    expect((await backend.load(identity)).entry?.content?.text).toBe("Exact café 日本語 😀")
    const refused = new ComposerDrafts({
      backend: () => backend,
      scope: async (target) => ({ ...target, workspace: store.root }),
      owners: () => [{ box: "prompt:default", owner: "owner" }],
      generation: () => 1,
      post: () => undefined,
      message: async () => undefined,
    })
    try {
      await refused.handle({ type: "composerDraftPane", epoch: "pane", active: true })
      await refused.handle({
        ...base,
        type: "composerDraftSave",
        identity,
        mutation: "conflicting-save",
        content: { text: "Must not overwrite", comments: [], images: [], scroll: 0 },
      })
      const failure = refused.captureClose()
      await expect(failure).rejects.toThrow("capture closure failed")
      expect(refused.captureClose()).toBe(failure)
      expect((await backend.load(identity)).entry?.content?.text).toBe("Exact café 日本語 😀")
    } finally {
      await refused.captureClose().catch(() => undefined)
      refused.dispose()
    }
  } finally {
    release.resolve()
    await controller.captureClose().catch(() => undefined)
    controller.dispose()
  }
})

test("actual isolated host registry prevents later composer construction without initializing backend scope", () => {
  const result = Bun.spawnSync([process.execPath, path.resolve("tests/fixtures/draft-capture-registry.ts")], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  })
  expect(result.signalCode).toBeUndefined()
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true, portable: false })
})
