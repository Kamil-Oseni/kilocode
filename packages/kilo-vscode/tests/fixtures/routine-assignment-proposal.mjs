import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-proposal-dom",
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
  },
})

const window = new Window()
for (const name of [
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLHeadElement",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "MessageEvent",
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

const { createComponent, createSignal, onMount } = await import("solid-js")
const { render } = await import("solid-js/web")
const { DialogProvider, useDialog } = await import("@kilocode/kilo-ui/context/dialog")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { OrganizationAssignment } = await import("../../webview-ui/src/components/routines/OrganizationAssignment.tsx")
const root = document.createElement("div")
document.body.append(root)
const item = {
  version: 1,
  id: `org_${"a".repeat(32)}`,
  name: "Acceptance Team",
  revision: 2,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  members: [
    { agentID: "lead", role: "Coordinator", position: 0 },
    { agentID: "other", role: "Coordinator", position: 1 },
    { agentID: "writer", role: "Writer", position: 2 },
  ],
  delegations: [
    { senderID: "lead", recipientID: "writer", position: 0 },
    { senderID: "other", recipientID: "writer", position: 1 },
  ],
}
const [revision, setRevision] = createSignal(2)
const [available, setAvailable] = createSignal()
function Fixture() {
  const dialog = useDialog()
  onMount(() =>
    dialog.show(() =>
      createComponent(OrganizationAssignment, {
        get item() {
          return { ...item, revision: revision() }
        },
        get available() {
          return available()
        },
        agents: [
          { id: "lead", name: "Lead", enabled: true },
          { id: "other", name: "Other", enabled: true },
          { id: "writer", name: "Writer", enabled: true },
        ],
        onChoose: () => undefined,
        onPlan: () => undefined,
        onAssigned: () => undefined,
      }),
    ),
  )
  return null
}
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(Fixture, {})
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setImmediate(resolve))
const button = (name) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === name)
const reply = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))

try {
  await tick()
  const input = document.querySelector(".routines-assignment-simple textarea")
  assert.ok(input)
  input.value = "Prepare a report"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Review plan").click()
  await tick()
  const first = sent.findLast((msg) => msg.type === "routineOrganizationProposal")
  assert.equal(first.intent, "Prepare a report")
  assert.equal(
    sent.some((msg) => msg.type === "routineDelegate"),
    false,
  )

  input.value = "Prepare a reviewed report"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  reply({
    type: "routineOrganizationProposal",
    requestID: first.requestID,
    organizationID: item.id,
    proposal: {
      organizationID: item.id,
      revision: item.revision,
      senderID: "other",
      recipientID: "writer",
      objective: "Old draft",
      expected: "Old result",
      context: "",
    },
  })
  await tick()
  assert.equal(document.body.textContent.includes("Old draft"), false)
  assert.equal(input.value, "Prepare a reviewed report")

  button("Review plan").click()
  await tick()
  const second = sent.findLast((msg) => msg.type === "routineOrganizationProposal")
  assert.notEqual(second.requestID, first.requestID)
  reply({
    type: "routineOrganizationProposal",
    requestID: second.requestID,
    organizationID: item.id,
    error: "Provider unavailable",
  })
  await tick()
  assert.match(document.body.textContent, /Your request is still here/)
  assert.equal(input.value, "Prepare a reviewed report")
  assert.equal(
    sent.some((msg) => msg.type === "routineDelegate"),
    false,
  )

  button("Review plan").click()
  await tick()
  const third = sent.findLast((msg) => msg.type === "routineOrganizationProposal")
  assert.notEqual(third.requestID, second.requestID)
  reply({
    type: "routineOrganizationProposal",
    requestID: third.requestID,
    organizationID: item.id,
    proposal: {
      organizationID: item.id,
      revision: item.revision,
      senderID: "other",
      recipientID: "writer",
      objective: "Write a reviewed report",
      expected: "Report matches records",
      context: "Use current records",
    },
  })
  await tick()
  assert.match(document.body.textContent, /Other assigns to Writer/)
  assert.match(document.body.textContent, /Report matches records/)
  assert.equal(
    sent.some((msg) => msg.type === "routineDelegate"),
    false,
  )
  setRevision(3)
  await tick()
  assert.equal(button("Assign work").disabled, true)
  assert.match(document.body.textContent, /team changed after the plan was prepared/i)
  assert.equal(
    sent.some((msg) => msg.type === "routineDelegate"),
    false,
  )

  button("Change request").click()
  button("Review plan").click()
  await tick()
  const fourth = sent.findLast((msg) => msg.type === "routineOrganizationProposal")
  assert.equal(fourth.revision, 3)
  reply({
    type: "routineOrganizationProposal",
    requestID: fourth.requestID,
    organizationID: item.id,
    proposal: {
      organizationID: item.id,
      revision: 3,
      senderID: "other",
      recipientID: "writer",
      objective: "Write a reviewed report",
      expected: "Report matches records",
      context: "Use current records",
    },
  })
  await tick()
  setAvailable(0.5)
  await tick()
  assert.match(document.body.textContent, /No budget is available for this work/)
  assert.equal(button("Assign work").disabled, true)
  setAvailable()
  await tick()
  button("Assign work").click()
  await tick()
  const work = sent.findLast((msg) => msg.type === "routineDelegate")
  assert.equal(work.agentID, "other")
  assert.equal(work.recipientID, "writer")
  assert.equal(work.organizationRevision, 3)
  assert.equal(work.objective, "Write a reviewed report")
  assert.equal(work.expected, "Report matches records")
  assert.equal(work.context, "Use current records")
} finally {
  dispose()
  window.close()
}
