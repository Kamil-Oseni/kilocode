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
const { GoalBannerView } = await import("../../webview-ui/src/components/chat/GoalBanner.tsx")
const ref = { sessionID: "child", messageID: "message", partID: "part", callID: "call", summary: "Saved evidence" }
const goal = {
  objective: "Current objective",
  status: "active",
  createdAt: 2,
  updatedAt: 2,
  usage: { turns: 0, toolCalls: 0, continuations: 0 },
  progress: [],
  criteria: [
    { id: "current-check", description: "Current saved requirement", verification: "Run the saved acceptance check" },
  ],
  auditAttempt: {
    accepted: false,
    at: 2,
    reason: "The cited result is stale",
    requirements: [
      { criterionID: "current-check", requirement: "Unverified current claim", passed: true, evidence: [ref] },
      { requirement: "Unmet current criterion", passed: false, evidence: [] },
    ],
  },
  history: [
    { objective: "Legacy objective", status: "complete", createdAt: 0, updatedAt: 0 },
    {
      objective: "Archived objective",
      usage: { turns: 6, toolCalls: 12, continuations: 4 },
      activeMs: 3500,
      criteria: [
        { id: "archived", description: "Original saved criterion", verification: "Original verification method" },
      ],
      status: "complete",
      createdAt: 1,
      updatedAt: 1,
      audit: {
        summary: "Saved deliverable and checks",
        verifiedAt: 1,
        requirements: [{ requirement: "Archived criterion", passed: true, evidence: [ref] }],
      },
    },
  ],
}
const root = document.createElement("div")
document.body.append(root)
const [state, update] = createSignal(goal)
const tasks = [
  { content: "Inspect source", status: "in_progress", priority: "high" },
  { content: "Prepare environment", status: "in_progress", priority: "medium" },
  { content: "Run dependent check", status: "pending", priority: "medium" },
]
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(GoalBannerView, {
              get goal() {
                return state()
              },
              todos: tasks,
              sessionID: "parent",
              expanded: true,
              onAccept: () => sent.push({ type: "accept-review" }),
            })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const page = (name) => root.querySelector(`button[aria-label="${name}"]`).click()
await tick()
assert.ok(root.textContent.includes("Plan: Inspect source and 1 other task are marked in progress."))
assert.deepEqual(
  [...root.querySelectorAll(".goal-banner__task-status")].map((item) => item.textContent),
  ["in progress", "in progress", "pending"],
)
update({ ...goal, status: "paused" })
await tick()
assert.ok(!root.textContent.includes("Now:"))
assert.ok(root.textContent.includes("are marked in progress."))
update({ ...goal, status: "complete", audit: { summary: "Accepted result summary", requirements: [], verifiedAt: 2 } })
await tick()
assert.ok(root.querySelector(".goal-banner__progress").textContent.includes("Accepted result summary"))
assert.ok(!root.querySelector(".goal-banner__progress").textContent.includes("marked in progress"))
update(goal)
await tick()
assert.ok(root.textContent.includes("Completion rejected"))
assert.ok(root.querySelector('[aria-label="Saved acceptance criteria"]'))
assert.ok(root.textContent.includes("Current saved requirement"))
assert.ok(root.textContent.includes("Verification: Run the saved acceptance check"))
assert.ok(root.textContent.includes("Criterion: current-check"))
assert.ok(root.textContent.includes("The cited result is stale"))
assert.ok(root.textContent.includes("Reported satisfied; evidence not accepted."))
assert.ok(root.textContent.includes("Reported unmet."))
assert.equal(root.querySelectorAll(".goal-banner__audit-req[data-passed]").length, 0)
const copy = () => [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === "Copy goal report")
const acknowledge = (id, ok) =>
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: { type: "clipboardWriteResult", id, ok },
    }),
  )
copy().click()
await tick()
const first = sent.at(-1)
assert.equal(first.type, "copyToClipboard")
assert.ok(first.text.includes("Current saved requirement"))
assert.ok(first.text.includes("Completion rejected; submitted claims are unverified."))
assert.ok(!root.textContent.includes("Report copied."))
acknowledge(first.id, false)
await tick()
assert.ok(root.textContent.includes("Copy failed. Try again."))
copy().click()
await tick()
const stale = sent.at(-1)
page("Previous goal")
await tick()
acknowledge(stale.id, true)
await tick()
assert.ok(!root.textContent.includes("Report copied."))
copy().click()
await tick()
const archived = sent.at(-1)
assert.ok(archived.text.includes("Original saved criterion"))
assert.ok(archived.text.includes("Original verification method"))
assert.ok(archived.text.includes("Turns: 6\nTool calls: 12\nContinuations: 4"))
assert.ok(archived.text.includes("Accumulated active time: 3.5 seconds"))
assert.ok(!archived.text.includes("Turns: 0"))
assert.ok(archived.text.includes("Message: message"))
assert.ok(!archived.text.includes("Current saved requirement"))
acknowledge(archived.id, true)
await tick()
assert.ok(root.textContent.includes("Report copied."))
assert.ok(root.textContent.includes("Archived criterion"))
assert.ok(root.querySelector('[aria-label="Saved acceptance criteria"]'))
assert.ok(root.textContent.includes("Original saved criterion"))
assert.ok(root.textContent.includes("Original verification method"))
assert.ok(!root.textContent.includes("Current saved requirement"))
assert.ok(root.textContent.includes("Evidence accepted"))
assert.ok(root.textContent.includes("Saved deliverable and checks"))
assert.ok(root.textContent.includes("goal-control acceptance, when present, is recorded separately"))
assert.equal(root.querySelectorAll(".goal-banner__audit-req[data-passed]").length, 1)
assert.ok(!root.textContent.includes("Reported satisfied; evidence not accepted."))
assert.ok(![...root.querySelectorAll("button")].some((button) => button.textContent.includes("Steer")))
const button = [...root.querySelectorAll("button")].find((button) => button.textContent.includes("View source"))
assert.ok(button)
button.click()
await tick()
const request = sent.at(-1)
assert.equal(request.createdAt, 1)
assert.equal(request.sessionID, "parent")
page("Previous goal")
await tick()
assert.ok(root.textContent.includes("No completion audit was retained"))
assert.equal(root.querySelector('[aria-label="Saved acceptance criteria"]'), null)
assert.ok(!root.textContent.includes("Original saved criterion"))
window.dispatchEvent(
  new window.MessageEvent("message", {
    data: {
      type: "goalEvidenceResult",
      sessionID: "parent",
      requestID: request.requestID,
      source: {
        tool: "read",
        status: "completed",
        input: "{}",
        output: "LATE SOURCE",
        metadata: "{}",
        truncated: false,
      },
    },
  }),
)
await tick()
assert.ok(!root.textContent.includes("LATE SOURCE"))
page("Next goal")
await tick()
assert.ok(root.textContent.includes("Archived criterion"))
page("Next goal")
await tick()
assert.ok(root.textContent.includes("Current objective"))
assert.ok(!root.textContent.includes("Original saved criterion"))
assert.ok(root.textContent.includes("Current saved requirement"))
assert.ok(!root.textContent.includes("Archived criterion"))
assert.ok(root.textContent.includes("Completion rejected"))
assert.equal(root.querySelectorAll(".goal-banner__audit-req[data-passed]").length, 0)
const plan = {
  objective: goal.objective,
  revision: "plan-v1",
  at: 2,
  tasks: [
    {
      id: "inspect",
      description: "Inspect goal sources",
      output: "Source findings",
      owner: "code",
      verification: "Review findings",
      status: "completed",
      dependencies: [],
    },
    {
      id: "verify",
      description: "Verify goal output",
      output: "Test results",
      owner: "reviewer",
      verification: "Run actual checks",
      status: "in_progress",
      dependencies: ["inspect"],
    },
  ],
}
update({ ...goal, plan })
await tick()
assert.equal(root.querySelectorAll(".goal-banner__plan-task").length, 2)
assert.equal(root.querySelectorAll(".goal-banner__task-status").length, 0)
assert.equal(root.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "50")
assert.ok(root.textContent.includes("Plan: Verify goal output is marked in progress."))
assert.ok(root.textContent.includes("Source findings"))
assert.ok(root.textContent.includes("Run actual checks"))
assert.ok(root.textContent.includes("Dependenciesinspect"))
copy().click()
await tick()
assert.ok(sent.at(-1).text.includes("Expected output: Test results"))
acknowledge(sent.at(-1).id, true)
update({ ...goal, objective: "Revised objective", plan })
await tick()
assert.ok(root.textContent.includes("This plan needs review after the goal requirements changed."))
assert.ok(root.textContent.includes("saved work plan needs review"))
page("Previous goal")
await tick()
assert.equal(root.querySelector('[aria-label="Saved goal work plan"]'), null)
update({
  ...goal,
  plan,
  history: goal.history.map((item) => ({ ...item, plan: { ...plan, objective: item.objective } })),
})
await tick()
assert.ok(root.querySelector('[aria-label="Saved goal work plan"]'))
assert.ok(!root.textContent.includes("This plan needs review after the goal requirements changed."))

page("Next goal")
await tick()
update({
  ...goal,
  status: "complete",
  criteria: [
    { id: "required", description: "Required output", verification: "Review output" },
    { id: "optional", description: "Optional refinement", verification: "Review refinement", required: false },
  ],
  auditAttempt: {
    accepted: true,
    at: 3,
    requirements: [
      { criterionID: "required", requirement: "Required output", passed: true, evidence: [ref] },
      { criterionID: "optional", requirement: "Optional refinement", passed: false, evidence: [] },
    ],
  },
})
await tick()
assert.ok(root.textContent.includes("Optional"))
assert.ok(root.textContent.includes("Not verified. Optional criteria do not prevent goal completion."))
assert.equal(root.querySelectorAll(".goal-banner__audit-req[data-passed]").length, 1)
copy().click()
await tick()
assert.ok(sent.at(-1).text.includes("### Criterion optional\n\nOptional"))
assert.ok(sent.at(-1).text.includes("Reported satisfied: no"))
acknowledge(sent.at(-1).id, true)

const revision = {
  id: "retained-version",
  at: 2,
  source: "control",
  objective: "Superseded <script>objective</script>",
  criteria: [{ id: "old", description: "Superseded criterion", verification: "Earlier verification", required: false }],
  auditAttempt: {
    accepted: false,
    at: 1,
    reason: "Earlier rejected evidence",
    requirements: [{ requirement: "Earlier claim", passed: true, evidence: [ref] }],
  },
}
update({ ...goal, revisions: [revision] })
await tick()
const versions = () => root.querySelector('[aria-label="Earlier goal requirements"]')
assert.ok(versions().textContent.includes("Earlier requirements (1)"))
assert.ok(versions().textContent.includes("Superseded criterion"))
assert.ok(versions().textContent.includes("Earlier rejected evidence"))
assert.ok(versions().textContent.includes("Person identity was not recorded"))
assert.equal(versions().querySelector("script"), null)
assert.equal(versions().querySelectorAll(".goal-banner__audit-req[data-passed]").length, 0)
;[...versions().querySelectorAll("button")].find((item) => item.textContent.trim() === "View source").click()
await tick()
assert.equal(sent.at(-1).revisionID, "retained-version")
assert.equal(sent.at(-1).createdAt, goal.createdAt)
copy().click()
await tick()
assert.ok(sent.at(-1).text.includes("Superseded criterion"))
assert.ok(sent.at(-1).text.includes("Earlier rejected evidence"))
acknowledge(sent.at(-1).id, true)
page("Previous goal")
await tick()
assert.ok(!versions().textContent.includes("Superseded criterion"))
update({ ...goal, history: goal.history.map((item) => ({ ...item, revisions: [revision] })) })
await tick()
assert.ok(versions().textContent.includes("Superseded criterion"))
;[...versions().querySelectorAll("button")].find((item) => item.textContent.trim() === "View source").click()
await tick()
assert.equal(sent.at(-1).revisionID, "retained-version")
assert.equal(sent.at(-1).createdAt, 1)

page("Next goal")
const review = { status: "pending", at: 3, criteria: ["current-check"] }
update({
  ...goal,
  status: "paused",
  review,
  auditAttempt: undefined,
  audit: {
    summary: "Ready",
    verifiedAt: 3,
    requirements: [{ criterionID: "current-check", requirement: "Result", passed: true, evidence: [ref] }],
  },
})
await tick()
assert.ok(root.textContent.includes("Ready for your review"))
assert.equal(root.querySelectorAll(".goal-banner__audit-req[data-passed]").length, 0)
const accept = () =>
  [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === "Accept reviewed goal")
assert.ok(accept())
accept().click()
assert.equal(sent.at(-1).type, "accept-review")
update({ ...goal, status: "complete", review: { ...review, status: "accepted", acceptedAt: 4 } })
await tick()
assert.ok(root.textContent.includes("Goal accepted through review"))
assert.equal(accept(), undefined)
copy().click()
await tick()
assert.ok(sent.at(-1).text.includes("Goal-control review"))
assert.ok(sent.at(-1).text.includes("Review: accepted"))
acknowledge(sent.at(-1).id, true)
update({ ...goal, history: goal.history.map((item) => ({ ...item, review })) })
page("Previous goal")
await tick()
assert.ok(root.textContent.includes("Review was pending"))
assert.equal(accept(), undefined)

dispose()
window.happyDOM.abort()
