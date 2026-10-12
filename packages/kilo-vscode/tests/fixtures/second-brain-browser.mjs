import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "openai-provider-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
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
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
const emit = (id, state) =>
  window.dispatchEvent(new window.MessageEvent("message", { data: { type: "secondBrainState", id, state } }))
const values = new Map()
const keys = new Map()
const { BrainSettings } = await import("../../src/second-brain/settings.ts")
const { BrainService } = await import("../../src/second-brain/service.ts")
const settings = new BrainSettings(
  { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) },
  {
    get: async (key) => keys.get(key),
    store: async (key, value) => keys.set(key, value),
    delete: async (key) => keys.delete(key),
  },
)
const service = new BrainService(settings)
const jobs = []
let held
const release = new Promise((resolve) => {
  held = resolve
})
let posts = 0
const pins = Object.fromEntries(
  ["server.py", "index.py", "notes.py", "policy.py", "admission.py"].map((name) => [name, "a".repeat(64)]),
)
const root = "C:/Synthetic/SecondBrain"
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/health")
      return Response.json({
        ready: true,
        namespace_valid: true,
        retirement_pending: false,
        retirement_unconfirmed: false,
        draining: false,
        active: 0,
        admission_required: true,
        capture_enabled: false,
        root,
        source_sha256: pins,
      })
    posts++
    await release
    return Response.json({
      capture_enabled: false,
      results: [
        {
          path: root + "/General.md",
          relative: "General.md",
          line: 1,
          end_line: 1,
          heading: "Synthetic",
          text: "café 日本語 😀",
          source_sha256: "b".repeat(64),
          embedding_similarity: 0.5,
          relevance_score: 0.8,
        },
      ],
    })
  },
})
globalThis.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(message) {
    sent.push(message)
    if (message.type !== "secondBrain") return
    const job = (async () => {
      if (message.action === "setup")
        await settings.save(
          { format: "raya.memory.setup", version: 1, origin: server.url.origin, root, source_sha256: pins },
          "synthetic-private-key",
        )
      if (message.action === "cancel") await service.stop()
      if (message.action === "search") return service.run(message.query, (state) => emit(message.id, state))
      emit(message.id, await service.status())
    })()
    jobs.push(job)
  },
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { ServerProvider } = await import("../../webview-ui/src/context/server.tsx")
const { SecondBrain } = await import("../../webview-ui/src/components/settings/SecondBrain.tsx")
const node = document.createElement("main")
document.body.appendChild(node)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(ServerProvider, {
          get children() {
            return createComponent(SecondBrain, {})
          },
        })
      },
    }),
  node,
)
const wait = async (test) => {
  for (let i = 0; i < 100; i++) {
    if (test()) return
    await Bun.sleep(10)
  }
  throw new Error("Browser condition not reached: " + node.textContent.slice(0, 1200))
}
const button = (text) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)
try {
  await wait(() => sent.some((row) => row.action === "state"))
  await Promise.all(jobs)
  assert.match(node.textContent, /Setup required/)
  assert.match(node.textContent, /Set it up in conversation/)
  let setups = 0
  const guided = () => setups++
  window.addEventListener("raya:setup-memory", guided)
  assert.equal(button("Set up with Raya").disabled, true)
  assert.match(node.textContent, /Connect to Raya to set up memory/)
  button("Set up with Raya").click()
  assert.equal(setups, 0)
  window.dispatchEvent(new window.MessageEvent("message", { data: { type: "connectionState", state: "connected" } }))
  await wait(() => !button("Set up with Raya").disabled)
  assert.equal(node.textContent.includes("Connect to Raya to set up memory"), false)
  button("Set up with Raya").click()
  assert.equal(setups, 1)
  assert.equal(
    sent.some((row) => row.action === "setup"),
    false,
  )
  window.removeEventListener("raya:setup-memory", guided)
  assert.equal(node.textContent.includes("Import reviewed setup files"), false)
  assert.equal(button("Search notes"), undefined)
  assert.equal(posts, 0)
  button("Service settings").click()
  assert.equal(button("Service settings").getAttribute("aria-expanded"), "true")
  await wait(() => button("Import service setup"))
  assert.match(node.textContent, /Keep credentials in the secure input/)
  button("Import service setup").click()
  await wait(() => node.textContent.includes("Service not connected"))
  assert.match(node.textContent, /Manage your notes, automatic saving and search/)
  assert.equal(node.textContent.includes("Connect local memory, then choose"), false)
  for (const [label, action] of [
    ["Import control setup", "controlSetup"],
    ["Choose notes", "review"],
    ["Index selected notes", "sync"],
    ["Disable note access", "disable"],
  ]) {
    if (action === "sync")
      emit(sent.at(-1).id, { configured: true, status: "ready", results: [], control: { status: "approved" } })
    button(label).click()
    const request = sent.at(-1)
    assert.equal(request.action, action)
    assert.deepEqual(Object.keys(request).sort(), ["action", "id", "type"])
    await Promise.all(jobs)
  }
  const current = sent.at(-1).id
  emit(current, {
    configured: true,
    status: "disconnected",
    results: [],
    control: { status: "policy_disabled", hostJoinRequired: true },
  })
  assert.match(node.textContent, /Fully Paused is unavailable/)
  assert.equal(button("Search notes"), undefined)
  // Source-policy display metadata only; actual policy/native consent is a separate gate.
  emit(current, { configured: true, status: "ready", results: [], root, control: { status: "synced" } })
  assert.match(node.textContent, /Notes folder:/)
  assert.match(node.textContent, /Memory connected/)
  assert.match(node.textContent, /Selected notes indexed; search is ready/)
  const field = document.querySelector("input")
  field.value = "D:\\Raya\\Services\\Memory\\setup.json"
  field.dispatchEvent(new window.Event("input", { bubbles: true }))
  await wait(() => node.textContent.includes("This is a file path"))
  assert.equal(button("Search notes").disabled, true)
  assert.equal(button("Preview linked context").disabled, true)
  assert.equal(button("Choose setup file").disabled, false)
  assert.equal(posts, 0)
  field.value = "Synthetic query"
  field.dispatchEvent(new window.Event("input", { bubbles: true }))
  await wait(() => !button("Search notes").disabled)
  button("Search notes").click()
  await wait(() => posts === 1)
  const original = sent.filter((row) => row.action === "search").at(-1)
  button("Cancel search").click()
  await wait(() => node.textContent.includes("cancelled"))
  held()
  emit(original.id, { configured: true, status: "ready", results: [{ text: "OBSOLETE" }] })
  assert.equal(node.textContent.includes("OBSOLETE"), false)
  assert.equal(
    sent.some((row) => /sendMessage|memoryOperation/.test(row.type)),
    false,
  )
  assert.equal(JSON.stringify(sent).includes("synthetic-private-key"), false)
  // Unverified evidence must be explicit for both empty and nonempty searches.
  const latest = sent.at(-1).id
  emit(latest, { configured: true, status: "ready", results: [], recall: "unverified" })
  assert.match(node.textContent, /No factual passages returned/)
  assert.match(node.textContent, /No supporting answer has been verified/)
  emit(latest, {
    configured: true,
    status: "ready",
    results: [{ relative: "General.md", line: 1, end_line: 2, text: "Unverified passage" }],
    recall: "unverified",
    control: { status: "synced" },
  })
  assert.match(node.textContent, /Similarity matches only/)
  assert.match(node.textContent, /No supporting answer has been verified/)
  button("Preview linked context").click()
  const preview = sent.at(-1)
  assert.equal(preview.action, "context")
  assert.equal(preview.budget, 3000)
  assert.equal(preview.query, "Synthetic query")
  // Controlled display metadata only; the real native context flow is a separate gate.
  emit(preview.id, {
    configured: true,
    status: "ready",
    results: [],
    context: {
      sources: [
        {
          relative: "Projects/Eden.md",
          line: 2,
          end_line: 4,
          heading: "Eden",
          text: "Private synthetic passage",
          source_sha256: "a".repeat(64),
          depth: 1,
          tokens: 12,
          truncated: true,
        },
      ],
      diagnostics: [{ relative: "Missing.md", reason: "missing <img src=x>" }],
      tokens: 12,
      truncated: true,
      capture_enabled: false,
    },
  })
  assert.match(node.textContent, /12 estimated passage tokens/)
  assert.match(node.textContent, /Projects\/Eden.md/)
  assert.match(node.textContent, /Some context was omitted/)
  assert.match(node.textContent, /Limited passage/)
  assert.match(node.textContent, /Skipped links/)
  assert.match(node.textContent, /Missing.md: missing <img src=x>/)
  const details = [...node.querySelectorAll('[aria-label="Linked memory context"] details')]
  assert.equal(details.length, 2)
  assert.equal(
    details.every((item) => !item.open),
    true,
  )
  assert.equal(details[0].querySelector("summary").textContent, "Source details")
  assert.match(details[0].textContent, /Source SHA-256: a{64}/)
  assert.equal(details[1].querySelector("summary").textContent, "Skipped links (1)")
  details[1].open = true
  assert.equal(details[1].open, true)
  assert.equal(node.querySelector('[aria-label="Linked memory context"] img'), null)
  emit(original.id, {
    configured: true,
    status: "ready",
    results: [],
    context: { sources: [], diagnostics: [], tokens: 9999 },
  })
  assert.equal(node.textContent.includes("9999"), false)
  console.log("SecondBrain real DOM/host/HTTP handshake and cancellation passed")
} finally {
  held()
  dispose()
  await Promise.all(jobs)
  await service.dispose()
  await server.stop(true)
  await window.happyDOM.close()
}
