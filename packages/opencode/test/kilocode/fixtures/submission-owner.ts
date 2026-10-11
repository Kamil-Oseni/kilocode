import assert from "node:assert/strict"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { ComposerDrafts, type DraftBackend } from "../../../../kilo-vscode/src/kilo-provider/composer-drafts"
import { submit } from "../../../../kilo-vscode/src/kilo-provider/submission"
import { MessageConfirmation, sameDirectory } from "../../../../kilo-vscode/src/kilo-provider-utils"
import { withTimeout } from "../../../src/util/timeout"
import type {
  ComposerDraftExtensionMessage,
  DraftCapture,
  DraftContent,
  DraftIdentity,
} from "../../../../kilo-vscode/src/shared/composer-drafts-messages"

const root = process.env.RAYA_INPUT_PROFILE
if (!root) throw new Error("Missing private input profile")
const mode = process.argv[2]
assert(["stop", "changed"].includes(mode ?? ""))
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
const { Effect, Exit } = await import("effect")
const { InputReceipt } = await import("@opencode-ai/core/kilocode/input-receipt")
const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { SessionRetirement } = await import("../../../src/kilocode/session/retirement")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { MessageID } = await import("../../../src/session/schema")
const { createKiloClient } = await import("../../../../sdk/js/src/v2/client")
const paths = [
  join(process.cwd(), "../core/src/kilocode/input-receipt.ts"),
  join(process.cwd(), "../kilo-vscode/src/kilo-provider/submission.ts"),
  join(process.cwd(), "../kilo-vscode/src/KiloProvider.ts"),
  join(process.cwd(), "test/kilocode/fixtures/submission-owner.ts"),
  join(process.cwd(), "test/kilocode/submission-owner-process.test.ts"),
  join(process.cwd(), "../kilo-vscode/src/kilo-provider-utils.ts"),
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
const source = await Bun.file(paths[2]).text()
const start = source.indexOf("  private retryAbortControllers =")
const end = source.indexOf("  private maxCostSetting():", start)
assert(start >= 0 && end > start, "Exact production submission ownership methods must exist")
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`(class Subject { ${source.slice(start, end)} })`)
const module: { default?: unknown } = await import(
  `data:text/javascript;base64,${Buffer.from(`export default (submit, sameDirectory) => ${code}`).toString("base64")}`
)
assert.equal(typeof module.default, "function")
assert(typeof module.default === "function")
const Subject: unknown = module.default(submit, sameDirectory)
assert(typeof Subject === "function")
type Subject = {
  withRetry(run: () => Promise<{ error?: unknown }>, sid: string, messageID: string): Promise<void>
  cancelRetry(sid: string): void
  retryAbortControllers: Map<string, AbortController>
}
function valid(value: unknown): value is Subject {
  return (
    typeof value === "object" &&
    value !== null &&
    "withRetry" in value &&
    typeof value.withRetry === "function" &&
    "cancelRetry" in value &&
    typeof value.cancelRetry === "function" &&
    "retryAbortControllers" in value &&
    value.retryAbortControllers instanceof Map
  )
}
const ready = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const failures: string[] = []
const controllers: ComposerDrafts[] = []
const resources: { listener?: Awaited<ReturnType<typeof Server.listen>>; proxy?: Bun.Server<undefined> } = {}
const active: { run?: Promise<{ failed: boolean; error?: string }> } = {}
const receipt: Record<string, unknown> = { mode, realModelInference: false, sources: { before: pins } }
try {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  resources.listener = listener
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
      ready.resolve()
      await release.promise
      return new Response(raw, { status: response.status, headers: response.headers })
    },
  })
  resources.proxy = proxy
  const remote = createKiloClient({ baseUrl: String(proxy.url), directory: root })
  const posts: ComposerDraftExtensionMessage[] = []
  const events: unknown[] = []
  const backend: DraftBackend = {
    list: async (scope, cursor, limit) =>
      (await client.kilocode.composerDraft.list({ directory: root, scope, cursor, limit }, { throwOnError: true }))
        .data,
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
  const confirmations = new MessageConfirmation()
  const untrack = confirmations.track(message)
  const scope = { directory: root }
  const extracted: unknown = Reflect.construct(Subject, [])
  assert(valid(extracted), "Extracted production methods must retain their original runtime interface")
  const subject = Object.assign(extracted, {
    client: remote,
    connectionGeneration: 1,
    getWorkspaceDirectory: () => scope.directory,
    routeSessionDirectory: () => scope.directory,
    confirmations,
    postMessage: (value: unknown) => events.push(value),
  })
  active.run = subject
    .withRetry(
      () =>
        remote.session.prompt({
          directory: root,
          sessionID: session.id,
          messageID: message,
          noReply: true,
          agent: "build",
          model: { providerID: "fixture", modelID: "off" },
          parts: [
            { type: "text", text: content.text },
            { type: "text", text: "Original owned payload part" },
          ],
        }),
      session.id,
      message,
    )
    .then(
      () => ({ failed: false }),
      (err: unknown) => ({ failed: true, error: err instanceof Error ? err.message : String(err) }),
    )
  await withTimeout(ready.promise, 5_000, "Original saved receipt GET must enter before ownership changes")
  const beforeChange = (
    await client.session.message({ directory: root, sessionID: session.id, messageID: message }, { throwOnError: true })
  ).data
  assert(InputReceipt.complete(beforeChange, session.id, message))
  assert.equal(beforeChange.parts.length, 2)
  assert.deepEqual(
    beforeChange.parts.filter((part) => part.type === "text").map((part) => part.text),
    [content.text, "Original owned payload part"],
  )
  assert.equal(subject.retryAbortControllers.size, 1)
  if (mode === "stop") subject.cancelRetry(session.id)
  if (mode === "changed") {
    subject.client = createKiloClient({ baseUrl: String(listener.url), directory: root })
    subject.connectionGeneration++
    scope.directory = join(root, "changed-workspace")
  }
  release.resolve()
  const outcome = await withTimeout(
    active.run,
    5_000,
    "Original submission must join after its real receipt is released",
  )
  assert.equal(outcome.failed, mode === "changed")
  assert.equal(confirmations.has(message), false)
  assert.equal(subject.retryAbortControllers.size, 0)
  assert.deepEqual(events, mode === "stop" ? [{ type: "sessionStatus", sessionID: session.id, status: "idle" }] : [])
  const after = (await backend.load(target)).entry
  assert.deepEqual(after, before)
  const rows = (await client.session.messages({ directory: root, sessionID: session.id }, { throwOnError: true })).data
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], beforeChange)
  assert(InputReceipt.complete(rows[0], session.id, message))
  assert.equal(ledger.filter((item) => item.method === "POST").length, 1)
  assert.equal(ledger.filter((item) => item.method === "GET").length, 1)
  assert.equal(ledger[0].upstream, 200)
  assert.equal(ledger[0].status, 500)
  assert.equal(ledger[1].upstream, 200)
  assert.equal(ledger[0].path, `/session/${session.id}/message`)
  assert.equal(ledger[1].path, `/session/${session.id}/message/${message}`)
  const retirement = await Effect.runPromiseExit(SessionRetirement.drain)
  assert(Exit.isSuccess(retirement))
  Object.assign(receipt, {
    session: session.id,
    message,
    outcome,
    ledger,
    rows,
    beforeChange,
    before,
    after,
    content,
    posts,
    events,
    ownership: mode === "changed" ? "client, generation, and directory changed together" : "actual cancelRetry",
    confirmed: confirmations.has(message),
    pending: subject.retryAbortControllers.size,
    retired: true,
    methodScope: "Exact production methods extracted without a VS Code host; real SDK/HTTP/SQLite publication",
    extractedSHA: createHash("sha256").update(code).digest("hex"),
  })
  untrack()
  first.dispose()
} finally {
  release.resolve()
  if (active.run) {
    const result = await Promise.allSettled([active.run])
    receipt.originalJoined = result[0].status === "fulfilled"
    if (result[0].status === "rejected") failures.push(`original: ${String(result[0].reason)}`)
  }
  for (const controller of controllers) controller.dispose()
  const cleanups = [
    ["proxy", () => resources.proxy?.stop(false)],
    ["listener", () => resources.listener?.stop(true)],
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
  await Bun.write(join(root, "submission-owner.json"), JSON.stringify(receipt, null, 2))
  assert.deepEqual(final, pins, "Original submission source changed during its actual run")
}
