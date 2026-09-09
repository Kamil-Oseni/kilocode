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
const [todos, setTodos] = createSignal([])
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { GoalBanner } = await import("../../webview-ui/src/components/chat/GoalBanner.tsx")
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(SessionContext.Provider, {
              value: { currentSessionID: () => "session", todos },
              get children() {
                return createComponent(GoalBanner, {})
              },
            })
          },
        })
      },
    }),
  root,
)
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const button = (text) => {
  const found = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const draft = () => root.querySelector("textarea")
const type = (text) => {
  draft().value = text
  draft().dispatchEvent(new window.Event("input", { bubbles: true }))
}
const goal = {
  objective: "Original goal",
  intent: "original",
  status: "active",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  usage: { turns: 0, continuations: 0, toolCalls: 0 },
  progress: [],
}
try {
  await tick()
  emit({ type: "goalStopResult", sessionID: "other", notice: "Foreign stop result" })
  assert.ok(!root.textContent.includes("Foreign stop result"))
  emit({
    type: "goalStopResult",
    sessionID: "session",
    notice: "Last goal stop: tracking stopped; outcome unconfirmed.",
  })
  assert.ok(root.textContent.includes("Last goal stop"))
  emit({ type: "goalState", sessionID: "session", goal })
  emit({ type: "goalStopResult", sessionID: "session", notice: "Late old stop result" })
  assert.ok(root.textContent.includes("Original goal"))
  assert.ok(!root.textContent.includes("Late old stop result"))
  root.querySelector('[aria-label="Expand goal details"]').click()
  assert.equal(root.querySelector('[role="progressbar"]'), null)
  assert.ok(!root.querySelector(".goal-banner__usage").textContent.includes("%"))
  setTodos([
    { id: "one", content: "First task", status: "completed", priority: "medium" },
    { id: "two", content: "Second task", status: "in_progress", priority: "medium" },
    { id: "three", content: "Third task", status: "in_progress", priority: "medium" },
  ])
  assert.equal(root.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "33")
  assert.ok(root.querySelector(".goal-banner__usage").textContent.includes("Plan: 33% (1/3 tasks completed)"))
  assert.equal(
    root.querySelector(".goal-banner__progress").textContent,
    "Plan: Second task and 1 other task are marked in progress.",
  )
  emit({
    type: "goalState",
    sessionID: "session",
    goal: { ...goal, history: [{ ...goal, objective: "Earlier goal" }] },
  })
  root.querySelector('[aria-label="Previous goal"]').click()
  assert.equal(root.querySelector('[role="progressbar"]'), null)
  assert.equal(root.querySelector(".goal-banner__progress"), null)
  root.querySelector('[aria-label="Next goal"]').click()
  setTodos(todos().map((todo) => ({ ...todo, status: "completed" })))
  assert.equal(root.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "100")
  assert.equal(root.querySelector("section").dataset.status, "active")
  setTodos([])
  emit({ type: "goalState", sessionID: "session", goal })
  assert.equal(root.querySelector('[aria-label="Latest goal execution"]'), null)
  for (const [phase, outcome, text] of [
    ["queued", undefined, "queued. Execution has not been confirmed"],
    ["started", undefined, "Its outcome is not yet confirmed"],
    ["finished", "completed", "Goal completion still depends on its acceptance checks"],
    ["finished", "error", "ended with an error"],
    ["finished", "interrupted", "Review any changes and tool results before continuing"],
    ["finished", undefined, "turn finished"],
  ]) {
    emit({
      type: "goalState",
      sessionID: "session",
      goal: {
        ...goal,
        dispatch: { id: "dispatch", intent: "original", phase, outcome, queuedAt: goal.createdAt },
      },
    })
    assert.ok(root.querySelector('[aria-label="Latest goal execution"]').textContent.includes(text))
    assert.equal(root.querySelector("section").dataset.status, "active")
  }
  emit({ type: "goalState", sessionID: "session", goal })
  assert.equal(root.querySelector('[aria-label="Latest goal execution"]'), null)
  button("Pause").click()
  const pause = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(pause.status, "paused")
  assert.equal(pause.expectedIntent, "original")
  assert.ok(button("Pause").disabled)
  assert.equal(root.querySelector("section").dataset.status, "active")
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: pause.requestID,
    goal: { ...goal, intent: "paused", status: "paused" },
  })
  assert.equal(root.querySelector("section").dataset.status, "paused")
  button("Resume").click()
  const resume = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(resume.status, "active")
  assert.equal(resume.expectedIntent, "paused")
  emit({ type: "goalEdited", sessionID: "session", requestID: resume.requestID, error: "Conflict: reload the goal" })
  assert.ok(root.textContent.includes("Conflict"))
  assert.equal(root.querySelector("section").dataset.status, "paused")
  assert.equal(sent.at(-1).type, "goalGet")
  button("Steer").click()
  await tick()
  assert.ok(root.textContent.includes("The goal stays paused after this update."))
  button("Cancel").click()
  button("Resume").click()
  const next = sent.findLast((msg) => msg.type === "goalEdit")
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: next.requestID,
    goal: { ...goal, intent: "resumed", status: "active" },
  })
  assert.equal(root.querySelector("section").dataset.status, "active")
  button("Steer").click()
  assert.ok(
    root.textContent.includes(
      "Changing the objective or acceptance criteria moves the current audit and attempt into earlier requirements. They will not satisfy the revised goal.",
    ),
  )
  assert.ok(root.textContent.includes("Changing the objective or acceptance criteria moves the current audit"))
  await tick()
  assert.equal(draft().value, "Original goal")
  assert.ok(button("Update goal").disabled)
  assert.equal(document.activeElement === draft(), true)
  type("My draft")
  emit({
    type: "goalState",
    sessionID: "session",
    goal: { ...goal, objective: "Concurrent goal", intent: "concurrent" },
  })
  assert.equal(draft().value, "My draft")
  assert.equal(document.activeElement === draft(), true)
  button("Update goal").click()
  const first = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(first.objective, "My draft")
  assert.equal(first.expectedIntent, "resumed")
  assert.equal(draft().readOnly, true)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: "wrong",
    goal: { ...goal, objective: "My draft", intent: "saved" },
  })
  assert.ok(button("Saving…").disabled)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: first.requestID,
    error: "Conflict: review the latest goal",
  })
  assert.equal(draft().value, "My draft")
  assert.ok(root.querySelector('[role="alert"]').textContent.includes("Conflict"))
  assert.ok(button("Update goal").disabled)
  button("Steer").click()
  assert.ok(button("Update goal").disabled)
  button("Cancel").click()
  button("Steer").click()
  await tick()
  assert.equal(draft().value, "Concurrent goal")
  type("Reviewed draft")
  button("Update goal").click()
  const second = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(second.expectedIntent, "concurrent")
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: second.requestID,
    goal: { ...goal, objective: "Reviewed draft", intent: "saved" },
  })
  assert.equal(draft(), null)
  await tick()
  assert.equal(document.activeElement === button("Steer"), true)
  assert.ok(root.textContent.includes("Goal updated."))
  button("Steer").click()
  await tick()
  type("Timeout draft")
  button("Update goal").click()
  const third = sent.findLast((msg) => msg.type === "goalEdit")
  await new Promise((resolve) => setTimeout(resolve, 15_100))
  assert.equal(draft().value, "Timeout draft")
  assert.ok(button("Update goal").disabled)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: third.requestID,
    goal: { ...goal, objective: "Timeout draft", intent: "late" },
  })
  assert.equal(draft().value, "Timeout draft")
  assert.ok(root.querySelector('[role="alert"]').textContent.includes("may still finish"))
  emit({ type: "goalState", sessionID: "session" })
  assert.equal(draft().value, "Timeout draft")
  assert.ok(root.querySelector('[role="alert"]').textContent.includes("current goal"))
  button("Cancel").click()
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "latest" } })
  button("Steer").click()
  await tick()
  type("Concurrent acknowledgement draft")
  button("Update goal").click()
  const fourth = sent.findLast((msg) => msg.type === "goalEdit")
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "newer", objective: "Newer goal" } })
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: fourth.requestID,
    goal: { ...goal, objective: fourth.objective, intent: "old-ack" },
  })
  assert.equal(draft().value, "Concurrent acknowledgement draft")
  assert.ok(root.querySelector('[role="alert"]').textContent.includes("changed while"))
  assert.ok(root.textContent.includes("Newer goal"))
  button("Cancel").click()
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "before-timeout" } })
  button("Pause").click()
  const stalled = sent.findLast((msg) => msg.type === "goalEdit")
  await new Promise((resolve) => setTimeout(resolve, 15_100))
  assert.ok(root.textContent.includes("status change has not been confirmed"))
  assert.equal(root.querySelector("section").dataset.status, "active")
  assert.equal(sent.at(-1).type, "goalGet")
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: stalled.requestID,
    goal: { ...goal, intent: "late-pause", status: "paused" },
  })
  assert.equal(root.querySelector("section").dataset.status, "active")
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "before-draft-pause" } })
  button("Steer").click()
  await tick()
  type("Preserve this draft")
  button("Pause").click()
  const change = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(change.objective, "Original goal")
  assert.ok(button("Update goal").disabled)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: change.requestID,
    goal: { ...goal, intent: "paused-with-draft", status: "paused" },
  })
  assert.equal(draft().value, "Preserve this draft")
  assert.ok(root.querySelector('[role="alert"]').textContent.includes("status changed"))
  assert.ok(button("Update goal").disabled)
  button("Cancel").click()
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "stop-reviewed" } })
  button("Stop goal").click()
  emit({
    type: "goalState",
    sessionID: "session",
    goal: { ...goal, intent: "stop-newer", objective: "Newer stop objective" },
  })
  button("Stop goal").click()
  const stopping = sent.findLast((msg) => msg.type === "goalStop")
  assert.equal(stopping.expectedIntent, "stop-reviewed")
  assert.ok(button("Cancel").disabled)
  assert.ok(root.textContent.includes("Newer stop objective"))
  emit({ type: "goalStopped", sessionID: "session", requestID: "wrong", cleared: true })
  assert.ok(button("Cancel").disabled)
  emit({
    type: "goalStopped",
    sessionID: "session",
    requestID: stopping.requestID,
    error: "Goal changed. Review again.",
  })
  assert.ok(root.textContent.includes("Goal changed"))
  assert.ok(button("Stop goal").disabled)
  assert.equal(sent.at(-1).type, "goalGet")
  button("Cancel").click()
  button("Stop goal").click()
  button("Stop goal").click()
  const retried = sent.findLast((msg) => msg.type === "goalStop")
  assert.equal(retried.expectedIntent, "stop-newer")
  emit({ type: "goalStopped", sessionID: "session", requestID: retried.requestID, cleared: true })
  assert.ok(root.textContent.includes("Goal tracking stopped"))
  assert.ok(!root.textContent.includes("Newer stop objective"))
  assert.ok(root.textContent.includes("worker's outcome is not confirmed"))
  for (const worker of ["interrupted", "preserved"]) {
    emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: `stop-${worker}` } })
    button("Stop goal").click()
    button("Stop goal").click()
    const request = sent.findLast((msg) => msg.type === "goalStop")
    emit({
      type: "goalStopped",
      sessionID: "session",
      requestID: request.requestID,
      cleared: true,
      worker,
      background: "Related background work running at the stop check: Check output (child).",
    })
    assert.ok(root.textContent.includes("Check output (child)"))
    assert.ok(
      root.textContent.includes(
        worker === "interrupted" ? "its worker was interrupted" : "did not interrupt the parent worker",
      ),
    )
  }
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "stop-timeout" } })
  button("Stop goal").click()
  button("Stop goal").click()
  const uncertain = sent.findLast((msg) => msg.type === "goalStop")
  await new Promise((resolve) => setTimeout(resolve, 15_100))
  assert.ok(root.textContent.includes("Stopping has not been confirmed"))
  assert.ok(button("Stop goal").disabled)
  assert.equal(sent.at(-1).type, "goalGet")
  emit({ type: "goalStopped", sessionID: "session", requestID: uncertain.requestID, cleared: true })
  assert.ok(root.textContent.includes("Original goal"))

  button("Cancel").click()
  button("Stop goal").click()
  button("Stop goal").click()
  const raced = sent.findLast((msg) => msg.type === "goalStop")
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, objective: "Replacement", intent: "replacement" } })
  emit({ type: "goalStopped", sessionID: "session", requestID: raced.requestID, cleared: true })
  assert.ok(root.textContent.includes("Replacement"))
  assert.ok(root.textContent.includes("changed while stopping"))
  button("Cancel").click()
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, intent: "criteria" } })
  button("Steer").click()
  button("Add criterion").click()
  await tick()
  const field = root.querySelector("[data-criterion]")
  assert.equal(document.activeElement, field)
  field.value = "Deliver the working result"
  field.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.equal(document.activeElement, field)
  assert.ok(button("Update goal").disabled)
  const verification = root.querySelectorAll(".goal-banner__criteria-editor textarea")[1]
  verification.value = "Run the acceptance checks"
  verification.dispatchEvent(new window.Event("input", { bubbles: true }))
  const checkbox = root.querySelector('.goal-banner__criteria-editor input[type="checkbox"]')
  assert.equal(checkbox.checked, true)
  checkbox.click()
  assert.equal(checkbox.checked, false)
  assert.ok(!button("Update goal").disabled)
  button("Update goal").click()
  const criteria = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(criteria.objective, goal.objective)
  assert.equal(criteria.criteria.length, 1)
  assert.equal(criteria.criteria[0].required, false)
  assert.equal(criteria.expectedIntent, "criteria")
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: criteria.requestID,
    goal: { ...goal, intent: "missing-criteria" },
  })
  assert.ok(root.textContent.includes("Could not confirm"))
  assert.equal(root.querySelector("[data-criterion]").value, "Deliver the working result")
  button("Cancel").click()
  emit({
    type: "goalState",
    sessionID: "session",
    goal: { ...goal, intent: "criteria-saved", criteria: criteria.criteria },
  })
  button("Steer").click()
  const changed = root.querySelectorAll(".goal-banner__criteria-editor textarea")[1]
  changed.value = "Run the expanded checks"
  changed.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Update goal").click()
  const accepted = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(accepted.criteria[0].id, criteria.criteria[0].id)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: accepted.requestID,
    goal: { ...goal, intent: "criteria-confirmed", criteria: accepted.criteria },
  })
  assert.equal(root.querySelector("[data-criterion]"), null)
  assert.ok(root.textContent.includes("Run the expanded checks"))
  button("Steer").click()
  const toggle = root.querySelector('.goal-banner__criteria-editor input[type="checkbox"]')
  assert.equal(toggle.checked, false)
  toggle.click()
  assert.ok(!button("Update goal").disabled)
  button("Update goal").click()
  const required = sent.findLast((msg) => msg.type === "goalEdit")
  assert.equal(required.criteria[0].required, true)
  emit({
    type: "goalEdited",
    sessionID: "session",
    requestID: required.requestID,
    goal: { ...goal, intent: "required-confirmed", criteria: required.criteria },
  })
  button("Steer").click()
  assert.equal(root.querySelector('.goal-banner__criteria-editor input[type="checkbox"]').checked, true)
  assert.equal(root.querySelector("[data-criterion]").getAttribute("data-criterion"), criteria.criteria[0].id)
  button("Remove criterion").click()
  assert.ok(button("Update goal").disabled)
  button("Cancel").click()
  emit({ type: "goalState", sessionID: "session", goal: { ...goal, status: "complete", intent: "completed" } })
  assert.equal(
    [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Steer"),
    false,
  )
  button("Dismiss goal").click()
  assert.ok(root.textContent.includes("Stop tracking this goal?"))
  button("Stop goal").click()
  assert.equal(sent.at(-1).expectedIntent, "completed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
