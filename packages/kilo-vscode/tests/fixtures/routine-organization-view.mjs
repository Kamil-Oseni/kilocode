import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-organization-dom",
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
  postMessage: (msg) => sent.push(msg),
  getState: () => ({}),
  setState: () => undefined,
})

const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { OrganizationActivity } = await import("../../webview-ui/src/components/routines/OrganizationActivity.tsx")
const root = document.createElement("div")
document.body.append(root)
const organizationID = `org_${"a".repeat(32)}`
const sender = "11111111-1111-4111-8111-111111111111"
const recipient = "22222222-2222-4222-8222-222222222222"
const plans = []
const item = {
  version: 1,
  id: organizationID,
  name: "Website Builders",
  revision: 1,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  members: [
    { agentID: sender, role: "Design", position: 0 },
    { agentID: recipient, role: "Frontend", position: 1 },
  ],
  delegations: [{ senderID: sender, recipientID: recipient, position: 0 }],
}

const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(OrganizationActivity, {
              id: organizationID,
              item,
              agents: [
                { id: sender, name: "Design Lead", enabled: true },
                { id: recipient, name: "Frontend Lead", enabled: true },
              ],
              onChoose: () => undefined,
              onAssigned: () => undefined,
              onPlan: (text) => plans.push(text),
            })
          },
        })
      },
    }),
  root,
)

try {
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.find((msg) => msg.type === "routineOrganizationActivity")
  assert.ok(request)
  emit({
    type: "routineOrganizationActivity",
    requestID: request.requestID,
    organizationID,
    items: [
      {
        id: "work_verified",
        sender: { id: sender, name: "Design Lead", role: "Designer", archived: false },
        recipient: { id: recipient, name: "Frontend Lead", role: "Developer", archived: false },
        organizationID,
        source: "delegate:verified",
        state: "queued",
        objective: "Build the approved landing page",
        time: 1,
        updated: 2,
      },
      {
        id: "work_complete",
        sender: { id: sender, name: "Design Lead", role: "Designer", archived: false },
        recipient: { id: recipient, name: "Frontend Lead", role: "Developer", archived: false },
        organizationID,
        source: "delegate:complete",
        state: "completed",
        objective: "Prepare the approved homepage file",
        time: 1,
        updated: 2,
        artifacts: [
          {
            path: "C:/Projects/Client/approved-homepage.fig",
            sha256: "d".repeat(64),
            tool: "write",
            callID: "call_approved_homepage",
          },
        ],
      },
    ],
    summary: {
      total: 2,
      active: 1,
      needsAttention: 0,
      uncertain: 0,
      recordedCost: 0,
      standaloneCost: 0,
      coordinatorCost: 0,
      committedCost: 0,
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.textContent, /Current 1/)
  assert.match(root.textContent, /History 1/)
  assert.match(root.textContent, /Build the approved landing page/)
  assert.doesNotMatch(root.textContent, /Prepare the approved homepage file/)
  assert.equal(root.querySelector('input[placeholder="Outcome or report"]'), null)
  const history = [...root.querySelectorAll(".routines-organization-work-views button")].find(
    (button) => button.textContent.trim() === "History 1",
  )
  assert.ok(history)
  history.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.doesNotMatch(root.textContent, /Build the approved landing page/)
  assert.match(root.textContent, /Prepare the approved homepage file/)
  assert.match(root.textContent, /Files handed off/)
  assert.match(root.textContent, /approved-homepage\.fig/)
  assert.match(root.textContent, /Verified · dddddddddddd/)
  const search = root.querySelector('input[placeholder="Outcome or report"]')
  search.value = "approved-homepage.fig"
  search.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.match(root.textContent, /Prepare the approved homepage file/)
  search.value = "missing-file.pdf"
  search.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.match(root.textContent, /No work matches these filters/)
  const assign = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Assign work")
  assert.ok(assign)
  assign.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(document.body.textContent, /What needs to get done/)
  assert.match(document.body.textContent, /Raya will prepare the route and result for you to review/)
  const intent = document.querySelector('textarea[placeholder^="For example: Check that this organization"]')
  assert.ok(intent)
  intent.value = "Verify the saved team and send me a concise report."
  intent.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setImmediate(resolve))
  const next = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Review plan")
  assert.ok(next)
  next.click()
  await new Promise((resolve) => setImmediate(resolve))
  const draft = sent.findLast((msg) => msg.type === "routineOrganizationProposal")
  assert.ok(draft)
  assert.equal(draft.organizationID, item.id)
  assert.equal(draft.revision, item.revision)
  assert.equal(draft.intent, "Verify the saved team and send me a concise report.")
  assert.deepEqual(plans, [])
} finally {
  dispose()
  window.close()
}

function emit(data) {
  window.dispatchEvent(new window.MessageEvent("message", { data }))
}
