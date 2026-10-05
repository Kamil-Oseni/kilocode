import { afterEach, describe, expect, it, spyOn } from "bun:test"
import {
  ComposerDrafts,
  composerIdentity,
  composerOwner,
  composerScopes,
  type DraftBackend,
} from "../../src/kilo-provider/composer-drafts"
import { resolveWorkspaceDirectory } from "../../src/kilo-provider-utils"
import { directories, scopes } from "../../src/agent-manager/composer-scopes"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  ComposerDraftExtensionMessage,
  DraftCapture,
  DraftEntry,
  DraftIdentity,
} from "../../src/shared/composer-drafts-messages"

const token = { generation: "4c4b325c-768d-451a-8aa2-c361772fcb55", revision: 1 }
const identity: DraftIdentity = {
  box: "prompt:default",
  key: "prompt:default:pending:first",
  workspace: "private",
  projectID: "project",
  pendingID: "first",
}
const entry: DraftEntry = {
  identity,
  token,
  content: { text: " exact draft \n", comments: [], images: [], scroll: 12 },
  mutation: "save",
  digest: "a".repeat(64),
}
const capture: DraftCapture = {
  identity,
  token,
  mutation: entry.mutation,
  digest: entry.digest,
  epoch: "pane",
  generation: 1,
  owner: "owner",
}
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

async function fixture() {
  const requests: Array<{ operation: string; body: unknown }> = []
  const posts: ComposerDraftExtensionMessage[] = []
  const state = {
    generation: 1,
    owner: "owner",
    connected: true,
    project: "project",
    role: "assistant",
    fail: false,
    entry: structuredClone(entry),
    delay: Promise.resolve(),
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const operation = new URL(request.url).pathname.slice(1)
      const body = await request.json()
      requests.push({ operation, body })
      await state.delay
      if (state.fail) return Response.json({ code: "conflict" }, { status: 400 })
      if (operation === "list") return Response.json({ entries: [state.entry] })
      if (operation === "promote")
        return Response.json({
          source: { ...state.entry, content: null },
          target: {
            ...state.entry,
            identity: {
              ...identity,
              key: "prompt:default:session:session",
              pendingID: undefined,
              sessionID: "session",
            },
          },
        })
      if (operation === "clear")
        return Response.json({ entry: { ...state.entry, content: null, token: { ...token, revision: 2 } } })
      return Response.json({ entry: state.entry })
    },
  })
  async function call<T>(operation: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(operation, server.url), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
    const result = await response.json()
    if (!response.ok) throw result
    return result as T
  }
  const backend: DraftBackend = {
    list: (scope) => call("list", { scope }),
    load: (identity) => call("load", { identity }),
    save: (identity, expected, content, mutation) => call("save", { identity, expected, content, mutation }),
    clear: (identity, expected, mutation) => call("clear", { identity, expected, mutation }),
    promote: (from, to, source, target, mutation) => call("promote", { from, to, source, target, mutation }),
  }
  const ctx: ConstructorParameters<typeof ComposerDrafts>[0] = {
    backend: () => (state.connected ? backend : undefined),
    generation: () => state.generation,
    owners: () => [{ box: identity.box, owner: state.owner }],
    scope: async (target) => ({ ...target, workspace: "private", projectID: state.project }),
    post: (message) => posts.push(message),
    message: async (sessionID, id) => ({ sessionID, id, role: state.role }),
  }
  const controller = new ComposerDrafts(ctx)
  cleanup.push(() => {
    controller.dispose()
    server.stop(true)
  })
  await controller.handle({ type: "composerDraftPane", active: true, epoch: "pane" })
  return { controller, state, posts, requests, ctx }
}

describe("durable composer host bridge", () => {
  it("does not read retired project scope generation after actual composer capture closure", async () => {
    const f = await fixture()
    await f.controller.captureClose()
    const posts = f.posts.length
    const requests = f.requests.length
    f.ctx.generation = () => {
      throw new Error("Project scope is retired for capture")
    }
    expect(() => f.controller.state()).not.toThrow()
    expect(f.posts).toHaveLength(posts)
    expect(f.requests).toHaveLength(requests)
    await expect(f.controller.reconcile()).rejects.toThrow("intake is retired")
    await expect(f.controller.captureClose()).resolves.toBeUndefined()
  })
  it("refuses old owner requests before transport when a reused box changes project", async () => {
    const f = await fixture()
    f.state.owner = "other-owner"
    f.state.project = "other"
    f.state.generation = 2
    f.controller.state()
    await f.controller.handle({
      type: "composerDraftSave",
      owner: "owner",
      identity,
      expected: token,
      content: entry.content!,
      mutation: "dirty-before-load",
      epoch: "pane",
      generation: 2,
      requestID: "old-owner",
    })
    expect(f.posts.at(-1)).toMatchObject({ error: "scope", owner: "owner" })
    expect(f.requests).toHaveLength(0)
    f.state.owner = "owner"
    f.state.project = "project"
    f.state.generation = 3
    f.controller.state()
    await f.controller.handle({
      type: "composerDraftLoad",
      owner: "owner",
      identity,
      epoch: "pane",
      generation: 3,
      requestID: "returned-owner",
    })
    expect(f.posts.at(-1)).toMatchObject({ entry: { content: entry.content }, owner: "owner" })
  })
  it("loads rich exact content and scoped pending discovery through the actual controller", async () => {
    const f = await fixture()
    await f.controller.handle({
      type: "composerDraftList",
      box: identity.box,
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "list",
    })
    await f.controller.handle({
      type: "composerDraftLoad",
      identity,
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "load",
    })
    expect(f.posts.at(-1)).toMatchObject({ requestID: "load", entry: { content: entry.content, mutation: "save" } })
    expect(f.requests[0]).toEqual({
      operation: "list",
      body: { scope: { workspace: "private", projectID: "project", box: identity.box } },
    })
  })
  it("promotes creation without clearing and clears only its exact accepted user message", async () => {
    const f = await fixture()
    await f.controller.prepare(capture, "session", "message")
    expect(f.requests.map((item) => item.operation)).toEqual(["load", "promote"])
    await f.controller.accepted("session", "message", "assistant")
    await f.controller.accepted("other", "message", "user")
    await f.controller.accepted("session", "wrong", "user")
    expect(f.requests).toHaveLength(2)
    await f.controller.accepted("session", "message", "user")
    expect(f.requests.at(-1)).toMatchObject({
      operation: "clear",
      body: { expected: token, mutation: "accepted:message" },
    })
    expect(f.posts.at(-1)).toMatchObject({
      type: "composerDraftAccepted",
      capture,
      messageID: "message",
      entry: { content: null },
    })
  })
  it("retains draft on failed promotion and rejects stale pane captures", async () => {
    const f = await fixture()
    f.state.fail = true
    await expect(f.controller.prepare(capture, "session", "message")).rejects.toBeDefined()
    f.state.fail = false
    await expect(f.controller.prepare({ ...capture, epoch: "old" }, "session", "message")).rejects.toMatchObject({
      code: "stale",
    })
    expect(f.requests.map((item) => item.operation)).toEqual(["load"])
  })
  it("preserves newer edits when accepted clear conflicts", async () => {
    const f = await fixture()
    await f.controller.prepare(capture, "session", "message")
    f.state.fail = true
    await f.controller.accepted("session", "message", "user")
    expect(f.posts.at(-1)).toMatchObject({ type: "composerDraftAccepted", error: "conflict" })
    expect(f.state.entry.content).toEqual(entry.content)
  })
  it("reconciles a lost acceptance after reconnect only with exact role:user receipt", async () => {
    const f = await fixture()
    await f.controller.prepare(capture, "session", "message")
    f.state.generation = 2
    f.state.connected = false
    f.controller.state()
    await f.controller.reconcile()
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(0)
    f.state.connected = true
    await f.controller.ready()
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(0)
    f.state.role = "user"
    await f.controller.ready()
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(1)
  })
  it("refuses cross-project recovery instead of clearing previous-project content", async () => {
    const f = await fixture()
    await f.controller.prepare(capture, "session", "message")
    f.state.project = "other"
    f.state.role = "user"
    f.state.generation = 2
    f.controller.state()
    await f.controller.reconcile()
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(0)
  })
  it("flush verifies durable commit proofs and refuses unacknowledged promotions", async () => {
    const f = await fixture()
    const pending = ComposerDrafts.flushAll(Date.now() + 1000)
    const request = f.posts.at(-1)
    if (request?.type !== "composerDraftFlush") throw new Error("Expected actual flush request")
    await f.controller.handle({
      type: "composerDraftFlushed",
      requestID: request.requestID,
      epoch: request.epoch,
      generation: request.generation,
      committed: true,
      entries: [capture],
    })
    await pending
    await f.controller.prepare(capture, "session", "message")
    await expect(f.controller.flush(Date.now() + 1000)).rejects.toMatchObject({ code: "promotion" })
  })
  it("refuses claimed commits, deadlines and disposal during capture", async () => {
    const f = await fixture()
    const pending = f.controller.flush(Date.now() + 1000)
    const request = f.posts.at(-1)
    if (request?.type !== "composerDraftFlush") throw new Error("Expected actual flush request")
    await f.controller.handle({
      type: "composerDraftFlushed",
      requestID: request.requestID,
      epoch: request.epoch,
      generation: request.generation,
      committed: true,
      entries: [{ ...capture, digest: "b".repeat(64) }],
    })
    await expect(pending).rejects.toMatchObject({ code: "conflict" })
    await expect(f.controller.flush(Date.now() - 1)).rejects.toThrow("timed out")
    const disposed = f.controller.flush(Date.now() + 1000)
    f.controller.dispose()
    await expect(disposed).rejects.toThrow("closed")
  })
  it("fences a newly registered pane and edits after committed proofs", async () => {
    const f = await fixture()
    const pending = ComposerDrafts.flushAll(Date.now() + 1000)
    const request = f.posts.at(-1)
    if (request?.type !== "composerDraftFlush") throw new Error("Expected actual flush request")
    await f.controller.handle({
      type: "composerDraftFlushed",
      requestID: request.requestID,
      epoch: request.epoch,
      generation: request.generation,
      committed: true,
      entries: [capture],
    })
    const check = await pending
    const fresh = await fixture()
    expect(check).toThrow("refused")
    fresh.controller.dispose()
    await f.controller.handle({
      type: "composerDraftLoad",
      identity,
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "later",
    })
    expect(check).toThrow("refused")
    const second = f.controller.flush(Date.now() + 1000)
    const again = f.posts.at(-1)
    if (again?.type !== "composerDraftFlush") throw new Error("Expected actual flush request")
    await f.controller.handle({
      type: "composerDraftFlushed",
      requestID: again.requestID,
      epoch: again.epoch,
      generation: again.generation,
      committed: true,
      entries: [capture],
    })
    const fence = await second
    await f.controller.handle({
      type: "composerDraftLoad",
      identity,
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "late-edit",
    })
    expect(fence).toThrow("refused")
  })
  it("derives AgentManager worktree ownership from exact host scopes and rejects stale routing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-composer-scope-"))
    try {
      const a = path.join(root, "a")
      const b = path.join(root, "b")
      await Promise.all([mkdir(a), mkdir(b)])
      const state = { directory: a, current: true, project: "project" }
      expect(scopes(undefined, [])).toEqual([])
      expect(directories(undefined)).toEqual([])
      expect(directories([{ path: a }])).toEqual([a])
      const ctx = {
        scopes: () => scopes(root, [{ id: "known", path: state.directory }]),
        current: () => state.current,
        ambiguous: () => false,
        project: async () => state.project,
        session: async () => ({ projectID: state.project, directory: a }),
      }
      const target = { box: "agent-manager:known", key: "opaque:path:cannot-select-scope", pendingID: "pending" }
      expect(await composerIdentity(target, ctx)).toMatchObject({ ...target, workspace: a, projectID: "project" })
      await expect(composerIdentity({ ...target, box: "agent-manager:unknown" }, ctx)).rejects.toMatchObject({
        code: "invalid",
      })
      await expect(composerIdentity({ ...target, projectID: "foreign" }, ctx)).rejects.toMatchObject({ code: "stale" })
      await expect(
        composerIdentity(
          { ...target, pendingID: undefined, sessionID: "session" },
          {
            ...ctx,
            project: async () => {
              state.directory = b
              return "project"
            },
          },
        ),
      ).rejects.toMatchObject({ code: "stale" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("reports only a static reason when session scope verification refuses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-composer-reason-"))
    const warning = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await expect(
        composerIdentity(
          {
            box: "private",
            key: "private-content-must-not-be-logged",
            sessionID: "private-session",
            projectID: "expected-project",
          },
          {
            scopes: () => [{ box: "private", directory: root }],
            current: () => true,
            ambiguous: () => false,
            project: async () => "expected-project",
            session: async () => ({ projectID: "different-project", directory: root }),
          },
        ),
      ).rejects.toMatchObject({ code: "stale" })
      expect(warning.mock.calls).toEqual([["[Raya] Composer draft scope changed", { reason: "project" }]])
    } finally {
      warning.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
  it("binds a restored session to its persisted logical project only in the exact selected physical directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-restored-composer-scope-"))
    const foreign = path.join(root, "foreign")
    await mkdir(foreign)
    try {
      const target = { box: "private", key: "retained", sessionID: "restored-session" }
      const ctx = {
        scopes: () => [{ box: "private", directory: root }],
        current: () => true,
        ambiguous: () => false,
        project: async () => "global",
        session: async () => ({ projectID: "original-git-project", directory: root }),
      }
      expect(await composerIdentity(target, ctx)).toMatchObject({
        ...target,
        workspace: root,
        projectID: "original-git-project",
      })
      await expect(
        composerIdentity(target, {
          ...ctx,
          session: async () => ({ projectID: "original-git-project", directory: foreign }),
        }),
      ).rejects.toMatchObject({ code: "stale" })
      await expect(composerIdentity({ ...target, projectID: "unrelated" }, ctx)).rejects.toMatchObject({
        code: "stale",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("binds existing and new sidebar drafts to the trusted worktree session directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-sidebar-scope-"))
    try {
      const worktree = path.join(root, "worktree")
      await mkdir(worktree)
      const sessions = new Map([["worktree-session", worktree]])
      const directory = (sessionID?: string) =>
        resolveWorkspaceDirectory({ sessionID, sessionDirectories: sessions, workspaceDirectory: root })
      const selected = { box: "prompt:default", key: "session-key", sessionID: "worktree-session" }
      const pending = { box: "sidebar:new-task", key: "pending-key", pendingID: "pending" }
      const ctx = (target: typeof selected | typeof pending) => ({
        scopes: () => composerScopes(target, { directory, sessionID: "worktree-session" }),
        current: () => true,
        ambiguous: () => false,
        project: async () => "project",
        session: async () => ({ projectID: "project", directory: worktree }),
      })
      expect((await composerIdentity(selected, ctx(selected))).workspace).toBe(worktree)
      expect((await composerIdentity(pending, ctx(pending))).workspace).toBe(worktree)
      expect(composerOwner(root, "project")).not.toBe(composerOwner(worktree, "project"))
      expect(composerOwner(root, "project")).not.toBe(composerOwner(root, "other-project"))
      expect(composerOwner(root, "project")).toBe(composerOwner(root, "project"))
      await expect(
        composerIdentity({ ...selected, sessionID: "unknown" }, ctx({ ...selected, sessionID: "unknown" })),
      ).rejects.toMatchObject({ code: "stale" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("reconciles durable dispatch stamps after the host controller restarts without resending", async () => {
    const f = await fixture()
    await f.controller.prepare(capture, "session", "message")
    f.state.entry = {
      ...entry,
      identity: { ...identity, pendingID: undefined, sessionID: "session" },
      mutation: "send:message",
    }
    f.controller.dispose()
    const restarted = new ComposerDrafts(f.ctx)
    cleanup.push(() => restarted.dispose())
    await restarted.handle({ type: "composerDraftPane", active: true, epoch: "new" })
    f.state.role = "user"
    await restarted.handle({
      type: "composerDraftLoad",
      identity: f.state.entry.identity,
      epoch: "new",
      generation: 1,
      owner: "owner",
      requestID: "recover",
    })
    expect(f.posts.at(-1)).toMatchObject({ operation: "composerDraftLoad", entry: { content: null } })
    expect(f.requests.filter((item) => item.operation === "promote")).toHaveLength(1)
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(1)
  })
  it("retains a pre-dispatch stamp and requires explicit reviewed editing after restart", async () => {
    const f = await fixture()
    f.state.entry = {
      ...entry,
      identity: { ...identity, pendingID: undefined, sessionID: "session" },
      mutation: "send:message",
    }
    await f.controller.handle({
      type: "composerDraftLoad",
      identity: f.state.entry.identity,
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "uncertain",
    })
    expect(f.posts.at(-1)).toMatchObject({ error: "uncertain", entry: { content: entry.content } })
    const request = {
      type: "composerDraftSave" as const,
      identity: f.state.entry.identity,
      expected: token,
      content: entry.content!,
      mutation: "reviewed",
      epoch: "pane",
      generation: 1,
      owner: "owner",
      requestID: "edit",
    }
    await f.controller.handle(request)
    expect(f.posts.at(-1)).toMatchObject({ error: "uncertain" })
    expect(f.requests.filter((item) => item.operation === "save")).toHaveLength(0)
    await f.controller.handle({ ...request, requestID: "review", reviewed: true })
    expect(f.requests.filter((item) => item.operation === "save")).toHaveLength(1)
    expect(f.requests.filter((item) => item.operation === "clear")).toHaveLength(0)
  })
})
