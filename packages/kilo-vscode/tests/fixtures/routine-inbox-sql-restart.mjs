import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

const phase = process.argv[2]
const root = path.resolve(process.argv[3] ?? "")
assert.ok((phase === "write" || phase === "read") && fs.existsSync(root))
const file = path.join(root, "routine.sqlite")
const profile = { database: file, storage: path.join(root, "storage") }
for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"])
  process.env[key] = path.join(root, key.toLowerCase())
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
  process.env[key] = path.join(root, key.toLowerCase())
process.env.KILO_MODELS_PATH = path.resolve(import.meta.dir, "../../../opencode/test/tool/fixtures/models-api.json")

plugin({
  name: "routine-inbox-sql-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path: file }) => {
      const result = await transformAsync(await Bun.file(file).text(), {
        filename: file,
        configFile: false,
        babelrc: false,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          import.meta.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("No compiled component")
      return { contents: result.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: "export default 'test-worker.js'", loader: "js" }))
  },
})

const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLHeadElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const { Effect, ManagedRuntime } = await import("../../../opencode/node_modules/effect/dist/index.js")
const { Database } = await import("@opencode-ai/core/database/database")
const { RayaTaskInbox } = await import("../../../opencode/src/kilocode/task/inbox.ts")
const { RoutineDrafts } = await import("../../src/kilo-provider/routine-drafts.ts")
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { Inbox } = await import("../../webview-ui/src/components/routines/Inbox.tsx")
const { RayaRoutineAttachmentTable: Attachment } = await import("@opencode-ai/core/kilocode/routine.sql")
const { eq } = await import("../../../opencode/node_modules/drizzle-orm/index.js")

const runtime = ManagedRuntime.make(Database.layerFromPath(file))
const sql = (body) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* body(RayaTaskInbox.make(database, profile), database)
    }),
  )
const pending = new Set()
const failures = []
const messages = []
const held = []
const drafts = new RoutineDrafts()
let webview =
  phase === "read" ? JSON.parse(fs.readFileSync(path.join(root, "webview.json"), "utf8")) : { unrelated: "retained" }
let hold = false
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const wait = async (condition, label) => {
  const until = Date.now() + 8000
  while (!condition()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(15)
  }
}
const bridge = async (msg) => {
  if (msg.type === "routineInboxPage") {
    const page = await sql((inbox) => inbox.page(msg.agentID))
    emit({ type: "routineInboxPage", requestID: msg.requestID, agentID: msg.agentID, ...page })
    return
  }
  if (msg.type === "routineInboxMount") {
    const read = async () => (await sql((inbox) => inbox.page(msg.agentID))).draftState
    const proof = await read()
    assert.equal(proof.owner, msg.owner)
    assert.equal(proof.conversationID, msg.conversationID)
    assert.equal(proof.revision, msg.revision)
    drafts.mount(msg.paneID, {
      agentID: msg.agentID,
      owner: proof.owner,
      conversationID: proof.conversationID,
      revision: proof.revision,
      current: () => true,
      read,
      write: (draft, attachmentIDs, revision) =>
        sql((inbox) =>
          inbox.draft(msg.agentID, {
            owner: proof.owner,
            conversationID: proof.conversationID,
            expectedRevision: revision,
            draft,
            attachmentIDs,
          }),
        ),
    })
    emit({
      type: "routineInboxMounted",
      requestID: msg.requestID,
      paneID: msg.paneID,
      agentID: msg.agentID,
      owner: proof.owner,
      conversationID: proof.conversationID,
      revision: proof.revision,
    })
    return
  }
  if (msg.type === "routineInboxDraft") {
    const ticket = drafts.issue(msg)
    ticket.before(msg.attachmentIDs)
    try {
      const proof = await sql((inbox) =>
        inbox.draft(msg.agentID, {
          owner: msg.owner,
          conversationID: msg.conversationID,
          expectedRevision: msg.expectedRevision,
          draft: msg.draft,
          attachmentIDs: msg.attachmentIDs,
        }),
      )
      ticket.settle(proof)
      const ack = {
        type: "routineInboxDraft",
        requestID: msg.requestID,
        agentID: msg.agentID,
        paneID: msg.paneID,
        sequence: msg.sequence,
        owner: proof.owner,
        conversationID: proof.conversationID,
        revision: proof.revision,
        draft: proof.draft,
        files: proof.attachments ?? [],
      }
      if (hold) held.push(ack)
      else emit(ack)
    } catch (error) {
      ticket.settle()
      throw error
    }
    return
  }
  if (msg.type === "routineInboxFlush") {
    const proof = await drafts.flush(
      msg.paneID,
      msg,
      {
        cutoff: msg.cutoff,
        draft: msg.draft,
        attachmentIDs: msg.attachmentIDs,
      },
      Date.now() + 5000,
    )
    emit({
      type: "routineInboxFlushed",
      requestID: msg.requestID,
      paneID: msg.paneID,
      agentID: msg.agentID,
      committed: true,
      owner: proof.owner,
      conversationID: proof.conversationID,
      revision: proof.revision,
    })
    return
  }
  if (msg.type === "routineInboxUnmount") drafts.unmount(msg.paneID, msg.agentID)
}
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => {
    messages.push(msg)
    const job = Promise.resolve().then(() => bridge(msg))
    pending.add(job)
    void job.then(
      () => pending.delete(job),
      (error) => {
        pending.delete(job)
        failures.push(error)
      },
    )
  },
  getState: () => webview,
  setState: (state) => {
    webview = state
  },
})

const first = await sql((inbox) => inbox.page("first"))
const second = await sql((inbox) => inbox.page("second"))
const upload = {
  id: "2c6b2156-835d-4c44-a8db-8698bd2e318a",
  name: "notes.txt",
  mime: "text/plain",
  size: 14,
  data: Buffer.from("exact bytes \u03A9").toString("base64"),
}
assert.equal(Buffer.from(upload.data, "base64").byteLength, upload.size)
const seeded =
  phase === "write"
    ? await sql((inbox) =>
        inbox.draft("first", {
          owner: first.draftState.owner,
          conversationID: first.draftState.conversationID,
          expectedRevision: first.draftState.revision,
          draft: "Initial",
          attachments: [upload],
        }),
      )
    : first.draftState
const [worker, setWorker] = createSignal("first")
const [box, setBox] = createSignal({
  agentID: "first",
  name: "First",
  role: "Reviewer",
  state: "idle",
  draft: seeded.draft,
  draftAttachments: seeded.attachments ?? [],
  draftRevision: seeded.revision,
  owner: seeded.owner,
  conversationID: seeded.conversationID,
})
const props = {
  get agentID() {
    return worker()
  },
  get box() {
    return box()
  },
  connection: "connected",
  name: "Draft worker",
  role: "Reviewer",
  workspace: "Books",
  objective: "Review",
  schedule: "When you ask",
  manual: true,
  access: "Read only",
  output: "Report",
  enabled: false,
  canInspect: false,
  onEdit() {},
  onAccess() {},
  onOutput() {},
  onInspect() {},
  onToggle() {},
}
const node = document.createElement("div")
document.body.append(node)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: {
            locale: () => "en",
            setLocale() {},
            userOverride: () => "",
            t: (key) => key,
          },
          get children() {
            return createComponent(SessionContext.Provider, {
              value: { agents: () => [] },
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(Inbox, props)
                  },
                })
              },
            })
          },
        })
      },
    }),
  node,
)
const field = () => node.querySelector("textarea[aria-label='Message this worker']")
const type = (value) => {
  assert.ok(field())
  field().value = value
  field().dispatchEvent(new window.Event("input", { bubbles: true }))
}
try {
  await wait(() => messages.some((msg) => msg.type === "routineInboxMount"), "mount request")
  await wait(() => !field().disabled, "SQL mount acknowledgement")
  if (phase === "write") {
    assert.equal(field().value, "Initial")
    assert.equal(node.textContent.includes("notes.txt"), true)
    hold = true
    type("  exact line\n ")
    await wait(() => held.length === 1, "SQL draft save")
    assert.equal((await sql((inbox) => inbox.page("first"))).draftState.draft, "  exact line\n ")
    emit({ ...held[0], owner: "foreign" })
    assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
    hold = false
    emit(held.shift())
    await wait(() => webview.routineInbox.drafts["agent:first"]?.pending === false, "exact SQL acknowledgement")
    type("Final before switch\n")
    setBox({
      agentID: "second",
      name: "Second",
      role: "Reviewer",
      state: "idle",
      owner: second.draftState.owner,
      conversationID: second.draftState.conversationID,
      draft: second.draftState.draft,
      draftRevision: second.draftState.revision,
    })
    setWorker("second")
    await wait(
      () => messages.some((msg) => msg.type === "routineInboxFlush" && msg.agentID === "first"),
      "worker switch flush",
    )
    await wait(
      () => messages.some((msg) => msg.type === "routineInboxUnmount" && msg.agentID === "first"),
      "verified flush",
    )
    const proof = (await sql((inbox) => inbox.page("first"))).draftState
    assert.equal(proof.draft, "Final before switch\n")
    assert.deepEqual(
      proof.attachments?.map((item) => item.id),
      [upload.id],
    )
    assert.equal(field().value, "")
    await Bun.write(path.join(root, "webview.json"), JSON.stringify(webview))
  } else {
    assert.equal(webview.unrelated, "retained")
    assert.equal(field().value, "Final before switch\n")
    assert.deepEqual(
      box().draftAttachments?.map((item) => item.id),
      [upload.id],
    )
    const rows = await sql((_, database) =>
      database.db.select().from(Attachment).where(eq(Attachment.agent_id, "first")).all(),
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].data, upload.data)
    assert.equal(Buffer.from(rows[0].data, "base64").toString(), "exact bytes \u03A9")
    const before = field().value
    emit({
      type: "routineInboxDraft",
      requestID: "stale-from-prior-process",
      agentID: "first",
      paneID: "old-pane",
      sequence: 1,
      owner: seeded.owner,
      conversationID: seeded.conversationID,
      revision: 999,
      draft: "old",
      files: [],
    })
    assert.equal(field().value, before)
    console.log(
      "ROUTINE_SQL_RESTART",
      JSON.stringify({
        phase,
        revision: seeded.revision,
        attachmentBytes: rows[0].size,
        ownerMatched: seeded.owner === first.draftState.owner,
      }),
    )
  }
  await Promise.allSettled([...pending])
  assert.deepEqual(failures, [])
} finally {
  dispose()
  const results = await Promise.allSettled([...pending])
  await runtime.dispose()
  node.remove()
  window.happyDOM.abort()
  if (results.some((result) => result.status === "rejected")) throw new Error("Routine fixture bridge failed")
}
