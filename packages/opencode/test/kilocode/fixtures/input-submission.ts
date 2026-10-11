import assert from "node:assert/strict"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { ComposerDrafts, type DraftBackend } from "../../../../kilo-vscode/src/kilo-provider/composer-drafts"
import { submit } from "../../../../kilo-vscode/src/kilo-provider/submission"
import type {
  ComposerDraftExtensionMessage,
  DraftCapture,
  DraftContent,
  DraftIdentity,
} from "../../../../kilo-vscode/src/shared/composer-drafts-messages"

const root = process.env.RAYA_INPUT_PROFILE
if (!root) throw new Error("Missing private input profile")
const mode = process.argv[2]
assert(["complete", "partial", "unavailable", "missing", "unidentified"].includes(mode ?? ""))
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
const { InputReceipt } = await import("@opencode-ai/core/kilocode/input-receipt")
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
const { MessageID } = await import("../../../src/session/schema")
const { createKiloClient } = await import("../../../../sdk/js/src/v2/client")
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const client = createKiloClient({ baseUrl: String(listener.url), directory: root })
const ledger: { method: string; path: string; status?: number; upstream?: number }[] = []
async function bytes(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 1024 * 1024) throw new Error("Original fixture HTTP body exceeded bound")
      chunks.push(item.value)
    }
    return Buffer.concat(chunks)
  } finally {
    reader.releaseLock()
  }
}
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const entry: { method: string; path: string; status?: number; upstream?: number } = {
      method: req.method,
      path: url.pathname,
    }
    ledger.push(entry)
    if (mode === "unavailable" && req.method === "GET") {
      entry.status = 503
      return new Response("Original receipt lookup unavailable", { status: 503 })
    }
    if (mode === "missing" && req.method === "POST") {
      entry.status = 503
      return new Response("Original request refused before forwarding", { status: 503 })
    }
    const body = await bytes(req.body)
    const response = await fetch(new URL(url.pathname + url.search, listener.url), {
      method: req.method,
      headers: req.headers,
      body: body.byteLength ? body : undefined,
    })
    const raw = await bytes(response.body)
    entry.upstream = response.status
    entry.status = req.method === "POST" ? 500 : response.status
    // Consume the actual publisher response before replacing only the transport result.
    if (req.method === "POST") return new Response("Original response lost after publisher settled", { status: 500 })
    return new Response(raw, { status: response.status, headers: response.headers })
  },
})
const remote = createKiloClient({ baseUrl: String(proxy.url), directory: root })
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
  clear: async (identity, expected, mutation) =>
    (
      await client.kilocode.composerDraft.clear(
        { directory: root, identity, expected, mutation },
        { throwOnError: true },
      )
    ).data,
  promote: async (from, to, source, target, mutation) =>
    (
      await client.kilocode.composerDraft.promote(
        { directory: root, from, to, source, target, mutation },
        { throwOnError: true },
      )
    ).data,
}
const paths = [
  join(process.cwd(), "../core/src/kilocode/input-receipt.ts"),
  join(process.cwd(), "../kilo-vscode/src/kilo-provider/submission.ts"),
  join(process.cwd(), "../kilo-vscode/src/KiloProvider.ts"),
  join(process.cwd(), "test/kilocode/fixtures/input-submission.ts"),
  join(process.cwd(), "test/kilocode/input-submission-process.test.ts"),
]
const hashes = () =>
  Promise.all(
    paths.map(async (path) => {
      const file = Bun.file(path)
      assert(file.size <= 2 * 1024 * 1024)
      const raw = new Uint8Array(await file.arrayBuffer())
      assert(raw.byteLength <= 2 * 1024 * 1024)
      return { path, bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") }
    }),
  )
const pins = await hashes()
const receipt: Record<string, unknown> = { mode, realModelInference: false, sources: { before: pins } }
try {
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
  if (mode === "partial")
    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: root },
          Database.Service.use((database) =>
            database.db
              .run(
                `CREATE TRIGGER refuse_owned_retry_part BEFORE INSERT ON part WHEN NEW.session_id = '${session.id}' AND NEW.message_id = '${message}' AND (SELECT COUNT(*) FROM part WHERE message_id = '${message}') = 1 BEGIN SELECT RAISE(ABORT, 'owned original retry part insert failed'); END`,
              )
              .pipe(Effect.orDie),
          ),
        ),
      ),
    )
  const outcome = await submit({
    run: () =>
      remote.session.prompt({
        directory: root,
        sessionID: session.id,
        messageID: mode === "unidentified" ? undefined : message,
        noReply: true,
        agent: "build",
        model: { providerID: "fixture", modelID: "off" },
        parts: [
          { type: "text", text: content.text },
          { type: "text", text: "Original second input part" },
        ],
      }),
    load: async () =>
      (
        await remote.session.message(
          { directory: root, sessionID: session.id, messageID: message },
          { throwOnError: true },
        )
      ).data,
    current: () => true,
    cancelled: () => false,
    sessionID: session.id,
    messageID: mode === "unidentified" ? undefined : message,
  }).then(
    (accepted) => ({ accepted, error: undefined }),
    (err: unknown) => ({ accepted: false, error: err instanceof Error ? err.message : String(err) }),
  )
  assert.equal(outcome.accepted, mode === "complete")
  assert.equal(!!outcome.error, mode !== "complete")
  if (outcome.accepted) await first.accepted(session.id, message, "user")
  const after = (await backend.load(target)).entry
  assert.deepEqual(after?.content, mode === "complete" ? null : content)
  assert.equal(after?.mutation, `${mode === "complete" ? "accepted" : "send"}:${message}`)
  const rows = (await client.session.messages({ directory: root, sessionID: session.id }, { throwOnError: true })).data
  assert.equal(rows.length, mode === "missing" ? 0 : 1)
  const actual = rows[0]
  if (actual) {
    assert.equal(actual.info.role, "user")
    assert.equal(actual.parts.length, mode === "partial" ? 1 : 2)
    if (mode === "unidentified") assert.notEqual(actual.info.id, message)
    if (mode !== "unidentified") assert.equal(actual.info.id, message)
    assert.equal(InputReceipt.complete(actual, session.id, actual.info.id), mode !== "partial")
  }
  const requests = ledger.filter((item) => item.method === "POST")
  assert.equal(requests.length, 1)
  assert.equal(requests[0].upstream, mode === "missing" ? undefined : mode === "partial" ? 500 : 200)
  assert.equal(requests[0].status, mode === "missing" ? 503 : 500)
  assert.equal(ledger.filter((item) => item.method === "GET").length, mode === "unidentified" ? 0 : 1)
  const retirement = await Effect.runPromiseExit(SessionRetirement.drain)
  assert.equal(Exit.isFailure(retirement), mode === "partial")
  Object.assign(receipt, {
    session: session.id,
    message,
    outcome,
    ledger,
    rows,
    before,
    after,
    content,
    retirement: {
      failed: Exit.isFailure(retirement),
      cause: Exit.isFailure(retirement) ? Cause.pretty(retirement.cause) : undefined,
    },
  })
  first.dispose()
} finally {
  for (const controller of controllers) controller.dispose()
  const cleanups = [
    ["proxy", () => proxy.stop(false)],
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
  const final = await hashes()
  receipt.sources = { before: pins, after: final }
  await Bun.write(join(root, "submission.json"), JSON.stringify(receipt, null, 2))
  assert.deepEqual(final, pins, "Original submission source changed during its actual run")
}
