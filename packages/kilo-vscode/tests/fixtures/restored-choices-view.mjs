import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "restored-choices-dom",
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
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
globalThis.acquireVsCodeApi = () => ({
  postMessage: (message) => sent.push(message),
  getState: () => ({}),
  setState: () => {},
})

const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { RestoredChoices } = await import("../../webview-ui/src/components/routines/RestoredChoices.tsx")
const root = document.createElement("div")
document.body.append(root)
const hold = crypto.randomUUID()
const host = crypto.randomUUID()
const owner = crypto.randomUUID()
const [identity, setIdentity] = createSignal({ id: hold, revision: "initial" })
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(RestoredChoices, {
          get id() {
            return identity().id
          },
          get revision() {
            return identity().revision
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setImmediate(resolve))
const emit = async (data) => {
  window.dispatchEvent(new window.MessageEvent("message", { data }))
  await tick()
}
const reads = () => sent.filter((item) => item.type === "restoreChoicesGet")
const writes = () => sent.filter((item) => item.type === "restoreChoicesApply")
const button = (label) => [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === label)
const choose = async (index, label) => {
  const trigger = root.querySelectorAll('[data-slot="select-select-trigger"]')[index]
  assert(trigger)
  trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await tick()
  const popup = document.getElementById(trigger.getAttribute("aria-controls"))
  assert(popup)
  const option = [...popup.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === label)
  assert(option, label)
  option.click()
  await tick()
}
const field = (label) =>
  [...root.querySelectorAll("fieldset")].find((item) => item.querySelector("legend")?.textContent === label)
const check = async (label) => {
  const box = field(label)?.querySelector('input[type="checkbox"]')
  assert(box)
  box.click()
  await tick()
}
const old = { providerID: "local", modelID: "old" }
const pick = { providerID: "local", modelID: "new" }
const saved = { providerID: "missing", modelID: "history" }
const preferences = {
  format: "raya.profile-preferences",
  version: 1,
  reviewOnly: true,
  activation: "held",
  config: { model: old, smallModel: old, defaultAgent: "general" },
  modelState: {
    models: [{ agent: "general", ...old }],
    recent: [old],
    favorite: [old],
    variants: [{ ...old, variant: "keep" }],
  },
  extensionState: { recentModels: [old], favoriteModels: [old], expanded: true },
}
const snapshot = {
  id: hold,
  choices: {
    version: 1,
    state: "ready",
    revision: "a".repeat(64),
    sources: [
      {
        kind: "profile",
        preferences: {
          ...preferences,
          config: { model: pick },
          modelState: { models: [], recent: [saved], favorite: [] },
          extensionState: {
            recentModels: [],
            favoriteModels: [],
            expanded: false,
            variants: [{ ...pick, agent: "general", variant: "" }],
          },
        },
      },
      {
        kind: "host",
        id: host,
        role: "view",
        revision: 4,
        models: {
          selected: saved,
          recent: [],
          favorite: [],
          agents: [],
          variants: [{ ...pick, variant: "not-present" }],
        },
        owners: [
          {
            id: owner,
            revision: 3,
            models: { recent: [saved], favorite: [], agents: [{ agent: "general", ...pick }] },
          },
        ],
      },
    ],
  },
  destination: { version: 1, revision: "b".repeat(64), preferences },
  availability: { models: [{ ...pick, variants: ["supported"] }], agents: ["general"] },
}
try {
  await tick()
  assert.equal(reads().length, 1)
  assert.equal(writes().length, 0)
  await emit({ type: "restoreChoicesResult", requestID: reads()[0].requestID, snapshot })
  assert(root.textContent.includes("Choose a saved source"))
  assert.equal(root.querySelectorAll("fieldset").length, 0)
  await choose(0, `Captured window ${host}`)
  assert.equal(
    field("Model choices by mode").querySelector("input").disabled,
    true,
    "Missing owner is not an empty map",
  )
  assert.equal(
    field("Global model choices").querySelector("input").disabled,
    true,
    "Unavailable active pick cannot silently fall back",
  )
  assert.equal(
    field("Picker preferences").querySelector("input").disabled,
    true,
    "Unavailable explicit variant refuses group",
  )
  await choose(1, `Saved owner ${owner}`)
  assert(field("Model choices by mode").textContent.includes("local/new"))
  await check("Model choices by mode")
  button("Apply reviewed choices").click()
  await tick()
  assert.deepEqual(writes()[0].application, {
    id: hold,
    revision: "a".repeat(64),
    source: { kind: "host", id: host, owner },
    expected: "b".repeat(64),
    groups: ["models"],
    reviewed: true,
  })
  const pending = writes()[0]
  await emit({
    type: "restoreChoicesResult",
    requestID: "wrong-request",
    snapshot,
    outcome: { state: "applied", confirmed: ["models"] },
  })
  assert.equal(button("Apply reviewed choices").disabled, true)
  await emit({
    type: "restoreChoicesResult",
    requestID: pending.requestID,
    snapshot,
    outcome: { state: "unknown", confirmed: [] },
  })
  assert.equal(button("Apply reviewed choices").disabled, true)
  assert.equal(writes().length, 1)
  button("Refresh saved choices").click()
  await tick()
  await emit({
    type: "restoreChoicesResult",
    requestID: pending.requestID,
    snapshot,
    outcome: { state: "applied", confirmed: ["models"] },
  })
  assert.equal(root.querySelectorAll("fieldset").length, 0, "Old apply cannot settle new read")
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  await choose(0, `Captured window ${host}`)
  await choose(1, `Saved owner ${owner}`)
  await check("Model choices by mode")
  button("Apply reviewed choices").click()
  await tick()
  const partial = writes().at(-1)
  await emit({
    type: "restoreChoicesResult",
    requestID: partial.requestID,
    snapshot,
    outcome: { state: "partial", confirmed: ["models"] },
  })
  assert(root.textContent.includes("does not confirm"), "False partial confirmation is refused")
  assert.equal(root.textContent.includes("Confirmed groups: Model choices by mode"), false)
  assert.equal(button("Apply reviewed choices")?.disabled ?? true, true)
  button("Refresh saved choices").click()
  await tick()
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  await choose(0, "Imported profile choices")
  assert.equal(
    field("Global model choices").querySelector("input").disabled,
    false,
    "Uncaptured unavailable current small model is kept",
  )
  assert(field("Global model choices").textContent.includes("local/old"))
  assert(field("Model history and variants").textContent.includes("missing/history"))
  assert.equal(
    field("Model history and variants").querySelector("input").disabled,
    false,
    "Unavailable historical IDs remain safe",
  )
  assert(field("Picker preferences").textContent.includes("Picker groups expanded: No"))
  assert(field("Picker preferences").textContent.includes("Mode general: local/new (Model default)"))
  await check("Global model choices")
  await check("Model history and variants")
  await check("Picker preferences")
  button("Apply reviewed choices").click()
  await tick()
  const second = writes().at(-1)
  assert.deepEqual(second.application.source, { kind: "profile" })
  assert.deepEqual(second.application.groups, ["config", "history", "client"])
  await emit({
    type: "restoreChoicesResult",
    requestID: second.requestID,
    snapshot,
    outcome: { state: "applied", confirmed: second.application.groups },
  })
  assert(root.textContent.includes("does not confirm"), "False success without matching destination is refused")
  assert.equal(button("Apply reviewed choices")?.disabled ?? true, true)
  button("Refresh saved choices").click()
  await tick()
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  await choose(0, "Imported profile choices")
  await check("Picker preferences")
  button("Apply reviewed choices").click()
  await tick()
  const third = writes().at(-1)
  await emit({
    type: "restoreChoicesResult",
    requestID: third.requestID,
    snapshot: {
      ...snapshot,
      destination: {
        ...snapshot.destination,
        revision: "c".repeat(64),
        preferences: {
          ...preferences,
          extensionState: {
            recentModels: [],
            favoriteModels: [],
            expanded: false,
            variants: [{ ...pick, agent: "general", variant: "" }],
          },
        },
      },
    },
    outcome: { state: "applied", confirmed: ["client"] },
  })
  assert(root.textContent.includes("Selected groups were applied."))
  button("Refresh saved choices").click()
  await tick()
  assert.equal(root.textContent.includes("Selected groups were applied."), false)
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  await choose(0, "Imported profile choices")
  await check("Global model choices")
  button("Apply reviewed choices").click()
  await tick()
  const held = writes().at(-1)
  const before = reads().length
  setIdentity({ id: hold, revision: "changed-during-apply" })
  await tick()
  assert.equal(reads().length, before, "Prop change during Apply must not automatically reconcile uncertainty")
  await emit({
    type: "restoreChoicesResult",
    requestID: held.requestID,
    snapshot,
    outcome: { state: "applied", confirmed: ["config"] },
  })
  assert.equal(root.querySelectorAll("fieldset").length, 0, "Old Apply cannot restore the invalidated view")
  button("Refresh saved choices").click()
  await tick()
  assert.equal(reads().length, before + 1, "Recovery needs a distinct explicit read")
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  await choose(0, "Imported profile choices")
  await check("Global model choices")
  button("Apply reviewed choices").click()
  await tick()
  const unknown = writes().at(-1)
  await emit({
    type: "restoreChoicesResult",
    requestID: unknown.requestID,
    snapshot,
    outcome: { state: "unknown", confirmed: [] },
  })
  const count = reads().length
  setIdentity({ id: hold, revision: "changed-after-unknown" })
  await tick()
  assert.equal(reads().length, count, "Prop change must not clear an existing unknown result")
  assert.equal(writes().length, 6, "Neither prop change may replay Apply")
  button("Refresh saved choices").click()
  await tick()
  assert.equal(reads().length, count + 1)
  await emit({ type: "restoreChoicesResult", requestID: reads().at(-1).requestID, snapshot })
  button("Refresh saved choices").click()
  await tick()
  const previous = reads().at(-1)
  setIdentity({ id: crypto.randomUUID(), revision: "replacement" })
  await tick()
  await emit({ type: "restoreChoicesResult", requestID: previous.requestID, snapshot })
  assert.equal(root.querySelectorAll("fieldset").length, 0)
  assert.equal(
    sent.some((item) => ["restoreReviewApprove", "routineRun", "routineUpdate", "sendMessage"].includes(item.type)),
    false,
  )
  assert.equal(writes().length, 6)
  console.log("restored choices mounted boundary passed")
} finally {
  dispose()
  window.happyDOM.abort()
}
