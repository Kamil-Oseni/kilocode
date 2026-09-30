import { describe, expect, it } from "bun:test"
import { ComposerDrafts, type DraftBackend } from "../../src/kilo-provider/composer-drafts"
import type { ComposerDraftExtensionMessage, DraftEntry } from "../../src/shared/composer-drafts-messages"

async function fixture() {
  const entries: DraftEntry[] = Array.from({ length: 217 }, (_, i) => ({
    identity: {
      workspace: "private",
      projectID: "project",
      box: "prompt:default",
      key: `draft-${i}`,
      pendingID: `id-${i}`,
    },
    token: { generation: "4c4b325c-768d-451a-8aa2-c361772fcb55", revision: 1 },
    content: { text: `retained ${i}`, comments: [], images: [], scroll: i },
    mutation: `save-${i}`,
    digest: "a".repeat(64),
  }))
  const posts: ComposerDraftExtensionMessage[] = []
  const requests: Array<{
    scope: { workspace: string; projectID?: string; box: string }
    cursor?: string
    limit?: number
  }> = []
  const state = {
    owner: "owner",
    generation: 1,
    connected: true,
    project: "project",
    mode: "normal",
    effects: 0,
    active: 0,
    peak: 0,
    proofs: 0,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number]
      requests.push(body)
      if (body.cursor === "second") {
        if (state.mode === "owner") state.owner = "other"
        if (state.mode === "disconnect") {
          state.connected = false
          state.generation++
        }
        if (state.mode === "project") state.project = "other-project"
        if (state.mode === "failure") return Response.json({ code: "unavailable" }, { status: 400 })
        if (state.mode === "repeat") return Response.json({ entries: entries.slice(100, 200), cursor: "second" })
        if (state.mode === "duplicate") return Response.json({ entries: [entries[0]] })
        if (state.mode === "empty") return Response.json({ entries: entries.slice(100, 200), cursor: "" })
        if (state.mode === "malformed") return Response.json({ entries: entries.slice(100, 200), cursor: 42 })
        if (state.mode === "foreign")
          return Response.json({
            entries: [{ ...entries[100], identity: { ...entries[100].identity, projectID: "foreign" } }],
          })
        return Response.json({ entries: entries.slice(100, 200), cursor: "third" })
      }
      if (body.cursor === "third") return Response.json({ entries: entries.slice(200) })
      return Response.json({ entries: entries.slice(0, 100), cursor: "second" })
    },
  })
  const unused = async (): Promise<never> => {
    state.effects++
    throw new Error("No catalog write expected")
  }
  const backend: DraftBackend = {
    async list(scope, cursor, limit) {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, cursor, limit }),
      })
      if (!response.ok) throw Object.assign(new Error("Catalog unavailable"), { code: "unavailable" })
      return response.json()
    },
    load: unused,
    save: unused,
    clear: async (identity, token) => {
      state.effects++
      const entry = entries.find((entry) => entry.identity.key === identity.key)
      if (!entry) throw new Error("Missing fixture draft")
      return { entry: { ...entry, content: null, token: { ...token, revision: token.revision + 1 } } }
    },
    promote: unused,
  }
  const controller = new ComposerDrafts({
    backend: () => (state.connected ? backend : undefined),
    generation: () => state.generation,
    owners: () => [{ box: "prompt:default", owner: state.owner }],
    scope: async (target) => ({ ...target, workspace: "private", projectID: state.project }),
    post: (message) => posts.push(message),
    message: async (sessionID, id) => {
      state.proofs++
      state.active++
      state.peak = Math.max(state.peak, state.active)
      await Bun.sleep(1)
      state.active--
      return { sessionID, id, role: "user" }
    },
  })
  await controller.handle({ type: "composerDraftPane", epoch: "pane", active: true })
  return {
    state,
    entries,
    requests,
    posts,
    async list() {
      await controller.handle({
        type: "composerDraftList",
        box: "prompt:default",
        owner: "owner",
        epoch: "pane",
        generation: 1,
        requestID: "catalog",
      })
    },
    [Symbol.dispose]() {
      controller.dispose()
      server.stop(true)
    },
  }
}

describe("composer host paginated catalog transport", () => {
  it("drains every page without evicting older drafts or changing the authoritative scope", async () => {
    using f = await fixture()
    await f.list()
    expect(f.posts.at(-1)).toMatchObject({ type: "composerDraftResult", entries: f.entries })
    expect(f.requests.map((item) => item.cursor)).toEqual([undefined, "second", "third"])
    expect(f.requests.every((item) => item.limit === 100)).toBe(true)
    expect(f.requests.every((item) => JSON.stringify(item.scope) === JSON.stringify(f.requests[0].scope))).toBe(true)
    expect(f.state.effects).toBe(0)
  })

  it("bounds actual accepted-message proof and CAS work while preserving all catalog entries", async () => {
    using f = await fixture()
    for (const entry of f.entries) {
      entry.mutation = `send:${entry.identity.key}`
      entry.identity.sessionID = `session-${entry.identity.key}`
      delete entry.identity.pendingID
    }
    await f.list()
    expect(f.state.proofs).toBe(217)
    expect(f.state.effects).toBe(217)
    expect(f.state.peak).toBe(8)
    expect(f.state.active).toBe(0)
    const result = f.posts.findLast((message) => message.type === "composerDraftResult")
    expect(result?.entries).toHaveLength(217)
    expect(result?.entries?.every((entry) => entry.content === null && entry.token.revision === 2)).toBe(true)
  })

  for (const mode of [
    "owner",
    "project",
    "failure",
    "repeat",
    "duplicate",
    "empty",
    "malformed",
    "foreign",
    "disconnect",
  ]) {
    it(`refuses the entire catalog after a later page ${mode} without partial publication or reconciliation writes`, async () => {
      using f = await fixture()
      f.state.mode = mode
      f.entries[0].mutation = "send:accepted-message"
      f.entries[0].identity.sessionID = "session"
      delete f.entries[0].identity.pendingID
      await f.list()
      const replies = f.posts.filter((message) => message.type === "composerDraftResult")
      expect(replies.every((message) => !message.entries)).toBe(true)
      expect(f.requests).toHaveLength(2)
      expect(f.state.effects).toBe(0)
      expect(f.state.proofs).toBe(0)
      if (mode !== "disconnect") expect(replies.at(-1)?.error).toBeDefined()
    })
  }
})
