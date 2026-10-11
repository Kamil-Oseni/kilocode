import assert from "node:assert/strict"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { ComposerDrafts, type DraftBackend } from "../../../../kilo-vscode/src/kilo-provider/composer-drafts"
import type {
  ComposerDraftExtensionMessage,
  DraftCapture,
  DraftContent,
  DraftIdentity,
} from "../../../../kilo-vscode/src/shared/composer-drafts-messages"

const root = process.env.RAYA_INPUT_PROFILE
if (!root) throw new Error("Missing private input profile")
const mode = process.argv[2]
assert(
  ["fault", "partial", "marker", "resolved", "live", "reminder", "foreign", "tampered", "cold", "reopen"].includes(
    mode ?? "",
  ),
)
const failed = mode === "fault" || mode === "partial" || mode === "marker"
const retained = failed || mode === "foreign" || mode === "tampered"
const reminder = mode === "reminder" || mode === "foreign" || mode === "tampered" || mode === "cold"
const attachment = mode === "marker" || mode === "resolved" || mode === "live" || reminder
process.env.KILO_CONFIG_CONTENT = JSON.stringify({
  snapshot: false,
  formatter: false,
  lsp: false,
  plugin: [],
  mcp: {},
  raya_routing: { goal_continuation: false },
  permission: "deny",
  enabled_providers: ["fixture"],
  model: "fixture/off",
  small_model: "fixture/off",
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "model-off" },
      models: { off: { name: "Model off", tool_call: true } },
    },
  },
})
process.env.RAYA_CONFIG_CONTENT = process.env.KILO_CONFIG_CONTENT
const { Effect, Exit, Cause } = await import("effect")
const { Database } = await import("@opencode-ai/core/database/database")
const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const { InstanceStore } = await import("../../../src/project/instance-store")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { SessionRetirement } = await import("../../../src/kilocode/session/retirement")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { MessageID, PartID, SessionID } = await import("../../../src/session/schema")
const { Session } = await import("../../../src/session/session")
const { Agent } = await import("../../../src/agent/agent")
const { SessionReminders } = await import("../../../src/session/reminders")
const { RayaRevertNote } = await import("../../../src/kilocode/session/revert-note")
const { KiloSessionPrompt } = await import("../../../src/kilocode/session/prompt")
const { InputReceipt } = await import("@opencode-ai/core/kilocode/input-receipt")
const { createKiloClient } = await import("../../../../sdk/js/src/v2/client")
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const requests: Array<{ method: string; path: string }> = []
const client = createKiloClient({
  baseUrl: String(listener.url),
  directory: root,
  fetch: async (input, init) => {
    const request = new Request(input, init)
    requests.push({ method: request.method, path: new URL(request.url).pathname })
    return fetch(request)
  },
})
const clears: string[] = []
const posts: ComposerDraftExtensionMessage[] = []
const failures: string[] = []
const controllers: ComposerDrafts[] = []
const backend: DraftBackend = {
  list: async (scope, cursor, limit) =>
    (await client.kilocode.composerDraft.list({ directory: root, scope, cursor, limit }, { throwOnError: true })).data,
  load: async (identity) =>
    (await client.kilocode.composerDraft.load({ directory: root, identity }, { throwOnError: true })).data,
  save: async (identity, expected, content, mutation) =>
    (
      await client.kilocode.composerDraft.save(
        { directory: root, identity, expected, content, mutation },
        { throwOnError: true },
      )
    ).data,
  clear: async (identity, expected, mutation) => {
    const result = (
      await client.kilocode.composerDraft.clear(
        { directory: root, identity, expected, mutation },
        { throwOnError: true },
      )
    ).data
    clears.push(mutation)
    return result
  },
  promote: async (from, to, source, target, mutation) =>
    (
      await client.kilocode.composerDraft.promote(
        { directory: root, from, to, source, target, mutation },
        { throwOnError: true },
      )
    ).data,
}
const receipt: Record<string, unknown> = { mode, realModelInference: false }
try {
  if (mode === "reopen") {
    const prior = await Bun.file(join(root, "cold.json")).json()
    assert.deepEqual(prior.cleanup, [])
    const target: DraftIdentity = prior.target
    const row = (
      await client.session.message(
        { directory: root, sessionID: prior.session, messageID: prior.message },
        { throwOnError: true },
      )
    ).data
    assert.deepEqual(row, prior.user)
    assert(InputReceipt.complete(row, prior.session, prior.message))
    const before = (await backend.load(target)).entry
    assert(before)
    assert.deepEqual(before, prior.before)
    assert.deepEqual(before?.content, prior.content)
    const ctx: ConstructorParameters<typeof ComposerDrafts>[0] = {
      backend: () => backend,
      generation: () => 1,
      owners: () => [{ box: target.box, owner: "physical-owner" }],
      scope: async (selected) => ({ ...selected, workspace: root, projectID: target.projectID }),
      post: (value) => posts.push(value),
      message: async (sid, id, directory) =>
        (await client.session.message({ sessionID: sid, messageID: id, directory }, { throwOnError: true })).data,
    }
    const controller = new ComposerDrafts(ctx)
    controllers.push(controller)
    await controller.handle({ type: "composerDraftPane", active: true, epoch: "cold-reopened" })
    const load = {
      type: "composerDraftLoad" as const,
      owner: "physical-owner",
      epoch: "cold-reopened",
      generation: 1,
      identity: target,
    }
    await controller.handle({ ...load, requestID: randomUUID() })
    const after = (await backend.load(target)).entry
    assert(after)
    assert.equal(after.content, null)
    assert.equal(after.mutation, `accepted:${prior.message}`)
    assert.equal(after.token.generation, before.token.generation)
    assert.equal(after.token.revision, before.token.revision + 1)
    assert.deepEqual(clears, [`accepted:${prior.message}`])
    await controller.handle({ ...load, requestID: randomUUID() })
    assert.deepEqual((await backend.load(target)).entry, after)
    assert.equal(clears.length, 1)
    const newer: DraftContent = { ...prior.content, text: "New ordinary draft after cold recovery\n" }
    const saved = (await backend.save(target, after.token, newer, "newer-after-cold")).entry
    await controller.reconcile()
    await controller.handle({ ...load, requestID: randomUUID() })
    assert.deepEqual((await backend.load(target)).entry, saved)
    assert.deepEqual(saved.content, newer)
    assert.equal(clears.length, 1)
    const actual = (
      await client.session.message(
        { directory: root, sessionID: prior.session, messageID: prior.message },
        { throwOnError: true },
      )
    ).data
    assert.deepEqual(actual, prior.user)
    assert(requests.every((item) => !item.path.includes("/prompt") && !item.path.includes("/abort")))
    assert(requests.filter((item) => item.path.startsWith("/session/")).every((item) => item.method === "GET"))
    const retirement = await Effect.runPromiseExit(SessionRetirement.drain)
    assert(Exit.isSuccess(retirement))
    Object.assign(receipt, {
      session: prior.session,
      message: prior.message,
      user: actual,
      before,
      after,
      newer: saved,
      target,
      capture: prior.capture,
      clears,
      retirement: { failed: false },
    })
  }
  if (mode !== "reopen") {
    const project = (await client.project.current({ directory: root }, { throwOnError: true })).data
    const session = (
      await client.session.create({ directory: root, title: "Actual input durability fault" }, { throwOnError: true })
    ).data
    const message = MessageID.ascending()
    const identity: DraftIdentity = {
      workspace: root,
      projectID: project.id,
      box: "prompt:default",
      key: "prompt:default:pending:input",
      pendingID: "input",
    }
    const content: DraftContent = {
      text: `Original payload ${randomUUID()}\n`,
      comments: [],
      images: [],
      scroll: 7,
      selection: { start: 2, end: 4 },
      agent: "build",
      model: { providerID: "fixture", modelID: "off" },
    }
    const saved = (await backend.save(identity, undefined, content, "original-save")).entry
    const capture: DraftCapture = {
      identity,
      token: saved.token,
      mutation: saved.mutation,
      digest: saved.digest,
      epoch: "pane",
      generation: 1,
      owner: "physical-owner",
    }
    const ctx: ConstructorParameters<typeof ComposerDrafts>[0] = {
      backend: () => backend,
      generation: () => 1,
      owners: () => [{ box: identity.box, owner: "physical-owner" }],
      scope: async (target) => ({ ...target, workspace: root, projectID: project.id }),
      post: (value) => posts.push(value),
      message: async (sid, id, directory) =>
        (await client.session.message({ sessionID: sid, messageID: id, directory }, { throwOnError: true })).data,
    }
    const first = new ComposerDrafts(ctx)
    controllers.push(first)
    await first.handle({ type: "composerDraftPane", active: true, epoch: "pane" })
    await first.validate(capture)
    await first.prepare(capture, session.id, message)
    const target: DraftIdentity = {
      workspace: root,
      projectID: project.id,
      box: identity.box,
      key: `prompt:default:session:${session.id}`,
      sessionID: session.id,
    }
    const before = (await backend.load(target)).entry
    assert.deepEqual(before?.content, content)
    assert.equal(before?.mutation, `send:${message}`)
    if (failed)
      await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: root },
            Database.Service.use((database) =>
              database.db
                .run(
                  `CREATE TRIGGER refuse_owned_input_part BEFORE INSERT ON part WHEN NEW.session_id = '${session.id}' AND NEW.message_id = '${message}'${mode === "partial" ? ` AND (SELECT COUNT(*) FROM part WHERE message_id = '${message}') = 1` : mode === "marker" ? ` AND json_extract(NEW.data, '$.metadata."raya.input.complete"') IS NOT NULL` : ""} BEGIN SELECT RAISE(ABORT, 'owned original input part insert failed'); END`,
                )
                .pipe(Effect.orDie),
            ),
          ),
        ),
      )
    const result = await client.session.prompt({
      directory: root,
      sessionID: session.id,
      messageID: message,
      noReply: true,
      agent: "build",
      model: { providerID: "fixture", modelID: "off" },
      parts: attachment
        ? [
            { type: "text", text: content.text },
            {
              type: "file",
              filename: "resolved.txt",
              mime: "text/plain",
              url: "data:text/plain;base64," + Buffer.from("Actual resolved attachment payload\n").toString("base64"),
            },
          ]
        : mode === "partial"
          ? [
              { type: "text", text: content.text },
              { type: "text", text: "Original second payload part" },
            ]
          : [{ type: "text", text: content.text }],
    })
    if (failed)
      assert(result.error || result.response.status >= 400, "Original SQLite part failure must fail the real request")
    if (!failed)
      assert(!result.error && result.response.status < 300, "Complete original input must succeed without inference")
    const original = (
      await client.session.message(
        { directory: root, sessionID: session.id, messageID: message },
        { throwOnError: true },
      )
    ).data
    assert.equal(original.info.role, "user")
    assert.equal(original.info.id, message)
    assert.equal(original.parts.length, mode === "fault" ? 0 : mode === "partial" ? 1 : 4)
    if (mode === "marker")
      assert(original.parts.every((part) => part.type !== "text" || !part.metadata?.["raya.input.complete"]))
    if (attachment) {
      assert.equal(original.parts.length, 4)
      assert(original.parts.some((part) => part.type === "text" && part.text === content.text))
      assert(
        original.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text === "Actual resolved attachment payload\n",
        ),
      )
      assert(original.parts.some((part) => part.type === "file" && part.filename === "resolved.txt"))
    }
    assert.equal(InputReceipt.complete(original, session.id, message), !failed)
    if (reminder)
      await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: root },
            Session.Service.use((base) =>
              Effect.gen(function* () {
                const sid = SessionID.make(session.id)
                if (mode === "foreign")
                  yield* base.updatePart({
                    id: PartID.ascending(),
                    sessionID: sid,
                    messageID: message,
                    type: "text",
                    text: "Unrelated actual addition outside the owned producer",
                    synthetic: true,
                  })
                const files = [join(root, "actual-reverted.txt")]
                yield* Effect.promise(() => RayaRevertNote.record(sid, files))
                const expected = RayaRevertNote.reminder(files)
                const agent = yield* Agent.Service.use((agents) => agents.get("build"))
                const current = yield* base.get(sid)
                const messages = yield* base.messages({ sessionID: sid })
                const ids = new Set(messages.flatMap((row) => row.parts.map((part) => part.id)))
                yield* KiloSessionPrompt.reminders(
                  base,
                  sid,
                  message,
                  Effect.gen(function* () {
                    const rows = yield* SessionReminders.apply({ messages, agent, session: current })
                    const row = rows.find((item) => item.info.id === message)
                    const part = row?.parts.find(
                      (item) => !ids.has(item.id) && item.type === "text" && item.text === expected,
                    )
                    assert(part?.type === "text", "Actual revert-note producer must persist its original reminder")
                    receipt.reminder = part
                    if (mode === "tampered")
                      yield* base.updatePart({ ...part, text: "Externally replaced actual returned reminder" })
                  }),
                )
              }),
            ),
          ),
        ),
      )
    const actual = (
      await client.session.message(
        { directory: root, sessionID: session.id, messageID: message },
        { throwOnError: true },
      )
    ).data
    assert.equal(
      actual.parts.length,
      mode === "fault"
        ? 0
        : mode === "partial"
          ? 1
          : mode === "reminder" || mode === "tampered" || mode === "cold"
            ? 5
            : mode === "foreign"
              ? 6
              : 4,
    )
    assert.equal(InputReceipt.complete(actual, session.id, message), !retained)
    receipt.original = original
    if (retained || mode === "live" || mode === "reminder") {
      // Exercise the live host acknowledgment with the actual observed original input.
      await first.accepted(session.id, message, actual.info.role)
      const acknowledged = (await backend.load(target)).entry
      assert.deepEqual(acknowledged?.content, retained ? content : null)
      assert.equal(acknowledged?.mutation, `${retained ? "send" : "accepted"}:${message}`)
      receipt.acknowledged = acknowledged
    }
    first.dispose()
    if (mode === "cold") {
      const after = (await backend.load(target)).entry
      assert.deepEqual(after, before)
      assert(InputReceipt.complete(actual, session.id, message))
      assert.equal(actual.parts.length, 5)
      assert.equal(clears.length, 0)
      const retirement = await Effect.runPromiseExit(SessionRetirement.drain)
      assert(Exit.isSuccess(retirement))
      Object.assign(receipt, {
        session: session.id,
        message,
        capture,
        target,
        request: { status: result.response.status, failed: !!result.error },
        user: actual,
        before,
        after,
        content,
        retirement: { failed: false },
      })
    } else {
      const second = new ComposerDrafts(ctx)
      controllers.push(second)
      await second.handle({ type: "composerDraftPane", active: true, epoch: "reopened" })
      await second.handle({
        type: "composerDraftLoad",
        owner: "physical-owner",
        epoch: "reopened",
        generation: 1,
        requestID: randomUUID(),
        identity: target,
      })
      const after = (await backend.load(target)).entry
      const retirement = await Effect.runPromiseExit(SessionRetirement.drain)
      assert.equal(Exit.isFailure(retirement), failed, "Actual producer exit must retain only genuine storage failures")
      receipt.session = session.id
      receipt.message = message
      receipt.request = { status: result.response.status, failed: !!result.error }
      receipt.user = actual
      receipt.before = before
      receipt.after = after
      receipt.content = content
      receipt.posts = posts
      receipt.retirement = {
        failed: Exit.isFailure(retirement),
        cause: Exit.isFailure(retirement) ? Cause.pretty(retirement.cause) : undefined,
      }
      receipt.baselineLoss = after?.content === null && after.mutation === `accepted:${message}`
    }
  }
} finally {
  for (const controller of controllers) controller.dispose()
  const cleanups = [
    ["listener", () => listener.stop(true)],
    ["handler", () => (HttpApiApp.webHandler.loaded() ? HttpApiApp.webHandler().dispose() : Promise.resolve())],
    ["ingest", () => KiloSessions.drainIngestForShutdown()],
    ["export", () => SessionExport.shutdown()],
    ["shutdown", () => KiloShutdown.run()],
    ["instances", () => InstanceRuntime.disposeAllInstances()],
    ["registry", () => RuntimeRegistry.drain()],
  ] as const
  for (const [name, close] of cleanups) {
    const result = await Promise.allSettled([Promise.resolve().then(close)])
    if (result[0].status === "rejected") failures.push(`${name}: ${String(result[0].reason)}`)
  }
  receipt.cleanup = failures
  receipt.requests = requests
  receipt.sources = await Promise.all(
    [
      "packages/core/src/kilocode/input-receipt.ts",
      "packages/kilo-vscode/src/kilo-provider/composer-drafts.ts",
      "packages/opencode/src/session/prompt.ts",
      "packages/opencode/src/kilocode/session/prompt.ts",
      "packages/opencode/test/kilocode/fixtures/accepted-input-draft.ts",
    ].map(async (path) => ({
      path,
      sha: createHash("sha256")
        .update(new Uint8Array(await Bun.file(join(import.meta.dir, "../../../../..", path)).arrayBuffer()))
        .digest("hex"),
    })),
  )
  await Bun.write(
    join(root, mode === "cold" || mode === "reopen" ? `${mode}.json` : "input-durability.json"),
    JSON.stringify(receipt, null, 2),
  )
}
