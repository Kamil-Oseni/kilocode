import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "goal-view-dom",
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
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => undefined,
  setState: () => {},
})
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { GoalCriteria } = await import("../../webview-ui/src/components/chat/GoalCriteria.tsx")
const { GoalAudit } = await import("../../webview-ui/src/components/chat/GoalAudit.tsx")
const requirements = [
  {
    criterionID: "required",
    requirement: "Deliver the report",
    passed: true,
    evidence: [
      { callID: "run", sessionID: "child", messageID: "message", partID: "part", summary: "<img src=x onerror=bad()>" },
    ],
  },
  { criterionID: "optional", requirement: "Review on a real device", passed: false, evidence: [] },
]
const initial = {
  createdAt: 1,
  criteria: [
    {
      id: "required",
      description: "Deliver the report",
      verification: "Inspect report.pdf and run report-check",
      required: true,
      check: { kind: "command", command: "bun run report-check", directory: "/workspace/report" },
    },
    { id: "optional", description: "Review on a real device", verification: "Test on a phone", required: false },
  ],
  audit: { summary: "Report prepared", requirements, verifiedAt: 2 },
  auditAttempt: { accepted: true, at: 2, requirements },
}
const [goal, setGoal] = createSignal(initial)
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(GoalAudit, {
              sessionID: "owner",
              get goal() {
                return goal()
              },
              empty: true,
            })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
try {
  await tick()
  assert.match(root.textContent, /Evidence references accepted/)
  assert.match(root.textContent, /Requested verification: Inspect report.pdf and run report-check/)
  assert.match(root.textContent, /Required command: bun run report-check/)
  assert.match(root.textContent, /Working directory: \/workspace\/report/)
  assert.match(root.textContent, /Reported satisfied; evidence references accepted/)
  assert.match(root.textContent, /Not verified. Optional criteria do not prevent goal completion/)
  assert.match(root.textContent, /Some criteria remain unverified/)
  assert.match(root.textContent, /no separate acceptance was recorded/)
  assert.match(root.textContent, /does not rerun checks or confirm later file changes/)
  assert.equal(root.querySelector("img"), null)
  const source = [...root.querySelectorAll("button")].find((button) => button.textContent.includes("View source"))
  assert.ok(source)
  source.click()
  assert.equal(sent.at(-1).type, "goalEvidence")
  assert.equal(sent.at(-1).evidence.partID, "part")
  setGoal({ ...initial, review: { status: "pending", at: 2, criteria: ["required"] } })
  await tick()
  assert.match(root.textContent, /User review: acceptance is pending/)
  assert.match(root.textContent, /use Steer to request changes/)
  assert.equal(root.querySelectorAll("[data-passed]").length, 0)
  setGoal({ ...initial, review: { status: "accepted", at: 2, acceptedAt: 3, criteria: ["required"] } })
  await tick()
  assert.match(root.textContent, /User review: acceptance was recorded through goal controls/)
  assert.equal(root.querySelectorAll("[data-passed]").length, 1)
  setGoal({ ...initial, auditAttempt: { accepted: false, reason: "Unrelated command", at: 4, requirements } })
  await tick()
  assert.match(root.textContent, /Completion rejected/)
  assert.match(root.textContent, /Unrelated command/)
  assert.doesNotMatch(root.textContent, /Report prepared/)
  assert.doesNotMatch(root.textContent, /Reported satisfied; evidence references accepted/)
  assert.equal(root.querySelector('[aria-label="Completion review limits"]'), null)
  const criteria = document.createElement("div")
  const cleanup = render(() => createComponent(GoalCriteria, { criteria: initial.criteria }), criteria)
  assert.match(criteria.textContent, /Required command: bun run report-check/)
  assert.match(criteria.textContent, /Working directory: \/workspace\/report/)
  cleanup()
  console.log("Goal audit result review assertions passed")
} finally {
  dispose()
  window.happyDOM.abort()
}
