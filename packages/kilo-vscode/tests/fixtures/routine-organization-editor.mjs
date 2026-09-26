import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-organization-editor-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const input = path.endsWith("RoutinesView.tsx")
        ? source.replace("function OrganizationEditor(", "export function OrganizationEditor(")
        : source
      const result = await transformAsync(input, {
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

const window = new Window({ url: "http://localhost" })
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
  "InputEvent",
  "MouseEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { OrganizationEditor } = await import("../../webview-ui/src/components/routines/RoutinesView.tsx")

const first = "11111111-1111-4111-8111-111111111111"
const second = "22222222-2222-4222-8222-222222222222"
const item = {
  id: `org_${"a".repeat(32)}`,
  name: "Website Builders",
  purpose: "Build the website",
  members: [
    { agentID: first, role: "Design", position: 0 },
    { agentID: second, role: "Frontend", position: 1 },
  ],
  delegations: [{ senderID: first, recipientID: second, position: 0 }],
}
const agents = [
  { id: first, name: "Design Lead", role: "Design", capabilities: [] },
  { id: second, name: "Frontend Lead", role: "Frontend", capabilities: [] },
]
const saves = []
let archives = 0
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(OrganizationEditor, {
      item,
      agents,
      saving: false,
      onClose: () => undefined,
      onSave: (value) => saves.push(value),
      onArchive: () => archives++,
      onProvision: () => undefined,
    }),
  root,
)

try {
  const rows = root.querySelectorAll(".routines-organization-member-settings")
  assert.equal(rows.length, 2)
  assert.match(rows[0].querySelector("summary").textContent, /Design Lead/)
  assert.match(rows[0].querySelector("summary").textContent, /Design/)
  assert.equal(rows[0].open, false)
  assert.ok(root.querySelector(".routines-organization-archive button"), "Archive button is visible in the editor")

  const row = root.querySelector(".routines-organization-member-settings")
  row.open = true
  row.dispatchEvent(new Event("toggle"))
  const role = row.querySelector('.routines-organization-member-fields input[maxlength="120"]')
  assert.ok(role, "The open worker exposes a role input")
  role.value = "Creative lead"
  role.$$input({ currentTarget: role })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.querySelector(".routines-organization-member-settings summary").textContent, /Creative lead/)

  const save = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save")
  assert.ok(save)
  save.click()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].members[0].role, "Creative lead")
  assert.deepEqual(saves[0].delegations, [{ senderID: first, recipientID: second }])

  const archive = [...root.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "Archive organization",
  )
  assert.ok(archive)
  archive.click()
  assert.equal(archives, 1)
} finally {
  dispose()
  window.happyDOM.abort()
}
