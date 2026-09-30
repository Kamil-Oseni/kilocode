import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { ComposerDrafts, composerOwner, type DraftBackend } from "../../src/kilo-provider/composer-drafts"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type {
  ComposerDraftExtensionMessage,
  ComposerDraftRequest,
  DraftCapture,
  DraftContent,
  DraftIdentity,
} from "../../src/shared/composer-drafts-messages"
import { draftStorage } from "../fixtures/durable-draft-storage"

describe("composer host with production durable Storage", () => {
  it("preserves rich content, promotes atomically, protects newer edits, and reconciles stamps after restart", async () => {
    const scope: { workspace?: string; projectID: string; owner: string } = {
      projectID: "fixture-project",
      owner: "disk-owner",
    }
    await using store = await draftStorage({
      workspace: () => scope.workspace ?? store.root,
      projectID: () => scope.projectID,
    })
    const posts: ComposerDraftExtensionMessage[] = []
    const state = { role: "assistant", generation: 1 }
    const call = async (request: ComposerDraftRequest) => {
      const result = await store.handle(request)
      if (result.error) throw Object.assign(new Error("Draft refused"), { code: result.error })
      return result
    }
    const base = () => ({ requestID: randomUUID(), epoch: "pane", generation: state.generation, owner: "disk-owner" })
    const backend: DraftBackend = {
      list: async (scope) => ({
        entries: (await call({ ...base(), type: "composerDraftList", box: scope.box })).entries ?? [],
      }),
      load: async (identity) => ({
        entry: (await call({ ...base(), type: "composerDraftLoad", identity })).entry ?? null,
      }),
      save: async (identity, expected, content, mutation) => {
        const result = await call({ ...base(), type: "composerDraftSave", identity, expected, content, mutation })
        if (!result.entry) throw new Error("Missing committed draft")
        return { entry: result.entry }
      },
      clear: async (identity, expected, mutation) => {
        const result = await call({ ...base(), type: "composerDraftClear", identity, expected, mutation })
        if (!result.entry) throw new Error("Missing committed tombstone")
        return { entry: result.entry }
      },
      promote: async (from, to, source, target, mutation) => {
        const result = await call({ ...base(), type: "composerDraftPromote", from, to, source, target, mutation })
        if (!result.source || !result.target) throw new Error("Missing committed promotion")
        return { source: result.source, target: result.target }
      },
    }
    const ctx: ConstructorParameters<typeof ComposerDrafts>[0] = {
      backend: () => backend,
      scope: async (target) => ({ ...target, workspace: scope.workspace ?? store.root, projectID: scope.projectID }),
      post: (message) => posts.push(message),
      generation: () => state.generation,
      owners: () => ["prompt:default", "agent-manager:local"].map((box) => ({ box, owner: scope.owner })),
      message: async (sessionID, id) => ({ sessionID, id, role: state.role }),
    }
    const identity: DraftIdentity = {
      workspace: store.root,
      box: "prompt:default",
      key: "prompt:default:pending:one",
      pendingID: "one",
    }
    const content: DraftContent = {
      text: "  Exact text\nwith trailing spaces  ",
      comments: [
        {
          id: "comment",
          file: "file.ts",
          side: "additions",
          line: 2,
          comment: "Keep this",
          selectedText: "const x = 1",
        },
      ],
      images: [{ id: "image", filename: "image.png", mime: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
      scroll: 21,
      selection: { start: 2, end: 7 },
      model: { providerID: "local", modelID: "qwen" },
      agent: "build",
      variant: "balanced",
    }
    const saved = (await backend.save(identity, undefined, content, "first-save")).entry
    const capture: DraftCapture = {
      identity,
      token: saved.token,
      mutation: saved.mutation,
      digest: saved.digest,
      epoch: "pane",
      generation: 1,
      owner: "disk-owner",
    }
    const controller = new ComposerDrafts(ctx)
    try {
      await controller.handle({ type: "composerDraftPane", active: true, epoch: "pane" })
      await controller.validate(capture)
      await controller.prepare(capture, "session", "message")
      const target: DraftIdentity = {
        workspace: store.root,
        box: identity.box,
        key: "prompt:default:session:session",
        sessionID: "session",
      }
      const promoted = (await backend.load(target)).entry!
      expect(promoted.content).toEqual(content)
      expect(promoted.mutation).toBe("send:message")
      expect((await backend.load(identity)).entry?.content).toBeNull()
      await controller.accepted("session", "message", "assistant")
      expect((await backend.load(target)).entry?.content).toEqual(content)
      const newer = { ...content, text: "Newer typing must survive" }
      const edited = (await backend.save(target, promoted.token, newer, "explicit-reviewed-edit")).entry
      await controller.accepted("session", "message", "user")
      expect((await backend.load(target)).entry?.content).toEqual(newer)
      expect(posts.at(-1)).toMatchObject({ type: "composerDraftAccepted", error: "conflict" })
      const next: DraftCapture = {
        ...capture,
        identity: target,
        token: edited.token,
        mutation: edited.mutation,
        digest: edited.digest,
      }
      await controller.prepare(next, "session", "second")
      expect((await backend.load(target)).entry?.mutation).toBe("send:second")
      controller.dispose()
      const restarted = new ComposerDrafts(ctx)
      try {
        await restarted.handle({ type: "composerDraftPane", active: true, epoch: "restarted" })
        await restarted.handle({ ...base(), epoch: "restarted", type: "composerDraftLoad", identity: target })
        expect(posts.at(-1)).toMatchObject({ error: "uncertain", entry: { content: newer } })
        expect((await backend.load(target)).entry?.content).toEqual(newer)
        state.role = "user"
        await restarted.handle({ ...base(), epoch: "restarted", type: "composerDraftLoad", identity: target })
        expect(posts.at(-1)).toMatchObject({ entry: { content: null } })
        expect((await backend.load(target)).entry?.mutation).toBe("accepted:second")
        expect((await backend.list({ workspace: store.root, box: identity.box })).entries).toHaveLength(2)
      } finally {
        restarted.dispose()
      }
      const a = path.join(store.root, "project-a")
      const b = path.join(store.root, "project-b")
      await Promise.all([mkdir(a), mkdir(b)])
      scope.workspace = a
      scope.projectID = "actual-project-a"
      scope.owner = composerOwner(a, scope.projectID)
      const owner = scope.owner
      state.generation++
      const partitioned = new ComposerDrafts(ctx)
      const pending = { box: "agent-manager:local", key: "same-opaque-key", pendingID: "same-pending-id" }
      try {
        await partitioned.handle({ type: "composerDraftPane", active: true, epoch: "scope" })
        await partitioned.handle({
          ...base(),
          owner,
          epoch: "scope",
          type: "composerDraftSave",
          identity: pending,
          content,
          mutation: "project-a-save",
        })
        expect(posts.at(-1)).toMatchObject({
          entry: { content, identity: { workspace: a, projectID: scope.projectID } },
        })
        scope.workspace = b
        scope.projectID = "actual-project-b"
        scope.owner = composerOwner(b, scope.projectID)
        state.generation++
        partitioned.state()
        await partitioned.handle({
          ...base(),
          owner,
          epoch: "scope",
          type: "composerDraftSave",
          identity: pending,
          content: { ...content, text: "dirty pre-hydrate A text" },
          mutation: "must-not-cross-save",
        })
        expect(posts.at(-1)).toMatchObject({ error: "scope" })
        await partitioned.handle({
          ...base(),
          owner: scope.owner,
          epoch: "scope",
          type: "composerDraftLoad",
          identity: pending,
        })
        expect(posts.at(-1)).toMatchObject({ entry: null })
        await partitioned.handle({
          ...base(),
          owner: scope.owner,
          epoch: "scope",
          type: "composerDraftSave",
          identity: pending,
          content: { ...content, text: "B only" },
          mutation: "project-b-save",
        })
        scope.workspace = a
        scope.projectID = "actual-project-a"
        scope.owner = owner
        state.generation++
        partitioned.state()
        await partitioned.handle({ ...base(), owner, epoch: "scope", type: "composerDraftLoad", identity: pending })
        expect(posts.at(-1)).toMatchObject({ entry: { content } })
      } finally {
        partitioned.dispose()
      }
    } finally {
      controller.dispose()
    }
  }, 30_000)
})
