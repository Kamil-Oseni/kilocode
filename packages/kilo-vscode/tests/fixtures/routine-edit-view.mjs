import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-view-dom",
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
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { default: RoutinesView } = await import("../../webview-ui/src/components/routines/RoutinesView.tsx")
const root = document.createElement("div")
const opened = []
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(SessionContext.Provider, {
              value: { agents: () => [] },
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(RoutinesView, { onOpenSession: (id) => opened.push(id) })
                  },
                })
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
try {
  await new Promise((resolve) => setImmediate(resolve))
  const agent = {
    id: "routine",
    name: "Review",
    role: "reviewer",
    objective: "Review changes",
    capabilities: [],
    schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" },
    scheduleVersion: 4,
    enabled: false,
  }
  emit({ type: "routineState", agents: [agent], templates: [] })
  emit({
    type: "routineState",
    error: "Request interrupted.",
    recovery: { kind: "connection", next: "Check the current routine before trying again." },
  })
  assert.match(root.querySelector('[role="alert"]').textContent, /Check the current routine/)
  emit({ type: "routineState", agents: [agent] })
  assert.match(root.querySelector('[role="alert"]').textContent, /Request interrupted/)
  button("Dismiss message").click()
  assert.equal(root.querySelector('[role="alert"]'), null)
  assert.equal(
    sent.some((msg) => msg.type === "routineRun"),
    false,
    "Dismissing a message must not repeat work",
  )
  {
    const output = {
      destination: "conversation",
      description: "Original report",
      criteria: [
        {
          id: "sources",
          description: "List sources",
          verification: "Check each source reference",
        },
      ],
    }
    emit({ type: "routineState", agents: [{ ...agent, output }], templates: [] })
    button("Edit output").click()
    await Promise.resolve()
    assert.match(document.activeElement.textContent, /Output requirements for Review/)
    const edit = root.querySelector("section textarea")
    assert.equal(edit.value, output.description)
    edit.value = "Edited report"
    edit.dispatchEvent(new window.Event("input", { bubbles: true }))
    button("Save requirements").click()
    const request = sent.findLast((msg) => msg.type === "routineOutputUpdate")
    assert.deepEqual(request.expectedOutput, output)
    assert.equal(request.output.description, "Edited report")
    emit({
      type: "routineState",
      agents: [{ ...agent, output: { ...output, description: "Concurrent report" } }],
      templates: [],
    })
    assert.equal(edit.value, "Edited report")
    emit({ type: "routineOutputUpdated", requestID: "stale", agentID: agent.id, output: request.output })
    assert.equal(button("Saving requirements").disabled, true)
    emit({
      type: "routineOutputUpdated",
      requestID: request.requestID,
      agentID: agent.id,
      error: "Output requirements changed; reload.",
      recovery: { kind: "conflict", field: "output", next: "Compare the saved requirements with your draft." },
    })
    assert.match(root.textContent, /Output requirements changed; reload/)
    assert.match(root.textContent, /Compare the saved requirements with your draft/)
    assert.equal(button("Save requirements").disabled, true)
    button("Compare with current requirements").click()
    const comparison = sent.findLast((msg) => msg.type === "routineList")
    const current = { ...output, description: "Concurrent report" }
    emit({ type: "routineState", requestID: "stale", agents: [{ ...agent, output: current }] })
    assert.equal(root.textContent.includes("Currently saved requirements"), false)
    emit({ type: "routineState", requestID: comparison.requestID, agents: [{ ...agent, output: current }] })
    assert.match(root.querySelector("[data-routine-comparison]").textContent, /Concurrent report/)
    assert.equal(edit.value, "Edited report")
    const count = sent.filter((msg) => msg.type === "routineOutputUpdate").length
    button("Keep my draft and continue editing").click()
    assert.equal(sent.filter((msg) => msg.type === "routineOutputUpdate").length, count)
    assert.equal(edit.value, "Edited report")
    button("Save requirements").click()
    assert.deepEqual(sent.findLast((msg) => msg.type === "routineOutputUpdate").expectedOutput, current)
    button("Close output review").click()
    await Promise.resolve()
    assert.equal(document.activeElement === button("Edit output"), true)
    emit({ type: "routineState", agents: [agent], templates: [] })
    button("Edit output").click()
    assert.equal(button("Save requirements").disabled, true)
    const fields = root.querySelectorAll("section textarea")
    for (const [index, value] of ["New report", "List sources", "Check references"].entries()) {
      fields[index].value = value
      fields[index].dispatchEvent(new window.Event("input", { bubbles: true }))
    }
    button("Save requirements").click()
    const saved = sent.findLast((msg) => msg.type === "routineOutputUpdate")
    assert.equal(saved.expectedOutput, "unset")
    emit({ type: "routineOutputUpdated", requestID: saved.requestID, agentID: agent.id, output: saved.output })
    assert.match(root.textContent, /Output requirements saved/)
    assert.equal(sent.at(-1).type, "routineList")
    button("Close output review").click()
    button("Edit output").click()
    for (const input of root.querySelectorAll("section textarea")) {
      input.value = "Required text"
      input.dispatchEvent(new window.Event("input", { bubbles: true }))
    }
    button("Save requirements").click()
    const late = sent.findLast((msg) => msg.type === "routineOutputUpdate")
    await new Promise((resolve) => setTimeout(resolve, 15_100))
    assert.match(root.textContent, /save could not be confirmed/)
    emit({ type: "routineOutputUpdated", requestID: late.requestID, agentID: agent.id, output: late.output })
    assert.doesNotMatch(root.textContent, /Output requirements saved/)
    button("Compare with current requirements").click()
    const missing = sent.findLast((msg) => msg.type === "routineList")
    emit({ type: "routineState", requestID: missing.requestID, agents: [] })
    assert.match(root.textContent, /no longer available/)
    assert.equal(root.querySelector("section textarea").value, "Required text")
    button("Close output review").click()
    emit({ type: "routineState", agents: [agent], templates: [] })
    await Promise.resolve()
  }
  assert.equal(button("Run now").disabled, true)
  button("Review access").click()
  await Promise.resolve()
  assert.match(document.activeElement.textContent, /Tool access for Review/)
  assert.match(root.textContent, /no saved access choice/)
  assert.doesNotMatch(root.textContent, /Writable location/)
  assert.equal(button("Save access").disabled, true)
  const access = root.querySelector("section[aria-labelledby] select")
  access.value = "brief"
  access.dispatchEvent(new window.Event("change", { bubbles: true }))
  button("Save access").click()
  const review = sent.findLast((msg) => msg.type === "routineAccessUpdate")
  assert.deepEqual(review, {
    type: "routineAccessUpdate",
    requestID: review.requestID,
    agentID: "routine",
    access: "brief",
    expectedAccess: "unset",
  })
  emit({ type: "routineAccessUpdated", requestID: "stale", agentID: "routine", access: "brief" })
  assert.ok(button("Saving access").disabled)
  emit({ type: "routineState", agents: [{ ...agent }], templates: [] })
  assert.ok(button("Saving access").disabled)
  emit({ type: "routineAccessUpdated", requestID: review.requestID, agentID: "routine", access: "brief" })
  assert.match(root.textContent, /Access saved/)
  assert.equal(sent.at(-1).type, "routineList")
  button("Close access review").click()
  await Promise.resolve()
  assert.equal(document.activeElement, button("Review access"))
  button("Review access").click()
  const picker = root.querySelector("section[aria-labelledby] select")
  picker.value = "full"
  picker.dispatchEvent(new window.Event("change", { bubbles: true }))
  button("Save access").click()
  const conflict = sent.findLast((msg) => msg.type === "routineAccessUpdate")
  emit({
    type: "routineAccessUpdated",
    requestID: conflict.requestID,
    agentID: "routine",
    error: "Access changed; reload.",
    recovery: { kind: "conflict", field: "access", next: "Compare the current access with your choice." },
  })
  assert.match(root.textContent, /Access changed; reload/)
  assert.match(root.textContent, /Compare the current access with your choice/)
  assert.ok(button("Save access").disabled)
  button("Close access review").click()
  emit({ type: "routineAccessUpdated", requestID: conflict.requestID, agentID: "routine", access: "full" })
  assert.doesNotMatch(root.textContent, /Access saved/)
  button("Review access").click()
  const pending = root.querySelector("section[aria-labelledby] select")
  pending.value = "brief"
  pending.dispatchEvent(new window.Event("change", { bubbles: true }))
  button("Save access").click()
  const uncertain = sent.findLast((msg) => msg.type === "routineAccessUpdate")
  await new Promise((resolve) => setTimeout(resolve, 15_100))
  assert.match(root.textContent, /save could not be confirmed/)
  assert.ok(button("Save access").disabled)
  emit({ type: "routineAccessUpdated", requestID: uncertain.requestID, agentID: "routine", access: "brief" })
  assert.doesNotMatch(root.textContent, /Access saved/)
  button("Close access review").click()
  assert.match(root.textContent, /Enabling allows future runs and starts a fresh consecutive-block count/)
  assert.match(root.textContent, /Earlier runs remain in history/)
  assert.match(
    document.getElementById(button("Enable").getAttribute("aria-describedby")).textContent,
    /Resolve the cause of a pause/,
  )
  button("Enable").click()
  assert.deepEqual(sent.at(-1), { type: "routineUpdate", agentID: "routine", enabled: true })
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  emit({ type: "routineState", agents: [{ ...agent, enabled: true }], templates: [] })
  assert.doesNotMatch(root.textContent, /Enabling allows future runs/)
  emit({ type: "routineState", agents: [agent], templates: [] })
  emit({
    type: "routineRuns",
    agentID: "routine",
    runs: [
      {
        id: "past",
        agentID: "routine",
        sessionID: "past-session",
        at: Date.parse("2026-09-08T12:05:00Z"),
        status: "complete",
        outcome: { kind: "code", summary: "Reviewed the release changes", cost: 0, evidence: ["Checks passed"] },
        trigger: {
          kind: "timer",
          id: "occurrence",
          scheduledAt: Date.parse("2026-09-08T12:00:00Z"),
          observedAt: Date.parse("2026-09-08T12:04:00Z"),
          tz: "UTC",
        },
      },
    ],
  })
  assert.match(root.textContent, /Scheduled for/)
  assert.match(root.textContent, /Startup began/)
  assert.match(root.querySelector(".routines-result-summary").textContent, /Reviewed the release changes/)
  emit({
    type: "routineState",
    agents: [{ ...agent, execution: { state: "recovery", sessionID: "recovered-session" } }],
  })
  emit({
    type: "routineRuns",
    agentID: "routine",
    runs: [
      {
        id: "recovered",
        agentID: "routine",
        sessionID: "recovered-session",
        at: Date.now(),
        status: "error",
        blockedReason: "No saved goal is available. Recovery review is required.",
      },
      {
        id: "newer",
        agentID: "routine",
        sessionID: "unrelated-session",
        at: Date.now() + 1,
        status: "complete",
        outcome: {
          kind: "code",
          summary: "A different run's result",
          cost: 0,
          evidence: ["Evidence <script>text</script>"],
          verification: {
            at: 1234,
            requirements: [
              {
                requirement: "Required outcome",
                required: true,
                passed: true,
                verification: "Inspect output",
                evidence: ["Evidence <script>text</script>"],
              },
              {
                requirement: "Optional outcome",
                required: false,
                passed: false,
                verification: "Inspect extra",
                evidence: [],
              },
            ],
          },
        },
      },
    ],
  })
  assert.match(root.textContent, /No saved goal is available/)
  assert.equal(root.querySelector(".routines-result-summary"), null)
  assert.match(root.textContent, /Recovery review required before another run/)
  assert.equal(root.querySelector(".routines-row").getAttribute("data-presence"), "error")
  button("Review run").click()
  assert.deepEqual(opened, ["recovered-session"])
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  button("Review runs").click()
  await Promise.resolve()
  const panel = root.querySelector(".routines-instructions")
  assert.equal(document.activeElement, panel)
  assert.equal(document.getElementById(button("Hide review").getAttribute("aria-controls")), panel)
  assert.match(panel.getAttribute("aria-label"), /Review/)
  assert.match(panel.textContent, /No result summary has been recorded/)
  const snapshot = sent.findLast((msg) => msg.type === "routineSnapshot")
  assert.equal(snapshot.runID, "recovered")
  assert.match(root.textContent, /Loading saved instructions/)
  const original = {
    version: 1,
    agentID: "routine",
    runID: "recovered",
    at: 1234,
    definition: { ...agent, objective: "Original definition" },
    objective: "Original <script>instructions</script>",
  }
  emit({ ...snapshot, snapshot: original, requestID: "stale" })
  assert.doesNotMatch(root.textContent, /Original <script>/)
  emit({ ...snapshot, snapshot: original })
  assert.match(root.textContent, /Original <script>instructions<\/script>/)
  assert.equal(root.querySelector(".routines-instructions script"), null)
  emit({
    type: "routineState",
    agents: [{ ...agent, execution: { state: "recovery", sessionID: "recovered-session" } }],
  })
  assert.match(root.textContent, /Original <script>/)
  assert.equal(sent.filter((msg) => msg.type === "routineSnapshot").length, 1)
  assert.equal(document.activeElement, panel)
  assert.equal(root.querySelector('pre[aria-label="Original instructions"]').tabIndex, 0)
  const saved = root.querySelector(".routines-instructions select")
  saved.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  assert.equal(root.querySelector(".routines-instructions"), panel)
  saved.value = "newer"
  saved.dispatchEvent(new window.Event("change", { bubbles: true }))
  const next = sent.findLast((msg) => msg.type === "routineSnapshot")
  assert.equal(next.runID, "newer")
  assert.match(panel.textContent, /A different run's result/)
  assert.match(panel.textContent, /Required: Verified at completion/)
  assert.match(panel.textContent, /Optional: Not verified/)
  assert.match(panel.textContent, /Verification method: Inspect extra/)
  assert.match(panel.textContent, /historical checks, not a new verification or your acceptance/)
  assert.match(panel.textContent, /Evidence <script>text<\/script>/)
  assert.equal(panel.querySelector("script"), null)
  button("Open conversation").click()
  assert.equal(opened.at(-1), "unrelated-session")
  assert.doesNotMatch(root.textContent, /Original <script>/)
  emit({ ...snapshot, snapshot: original })
  assert.match(root.textContent, /Loading saved instructions/)
  emit({ ...next, missing: true })
  assert.match(root.textContent, /No saved instructions are available/)
  saved.value = "recovered"
  saved.dispatchEvent(new window.Event("change", { bubbles: true }))
  const failed = sent.findLast((msg) => msg.type === "routineSnapshot")
  assert.doesNotMatch(panel.textContent, /A different run's result/)
  assert.doesNotMatch(panel.textContent, /Optional: Not verified/)
  emit({ ...failed, error: "Could not read saved data" })
  assert.match(root.textContent, /Could not read saved data/)
  button("Try again").click()
  const retry = sent.findLast((msg) => msg.type === "routineSnapshot")
  assert.notEqual(retry.requestID, failed.requestID)
  emit({ ...failed, snapshot: original })
  assert.match(root.textContent, /Loading saved instructions/)
  emit({ ...retry, snapshot: original })
  assert.match(root.textContent, /Original <script>/)
  button("Close review").click()
  await Promise.resolve()
  assert.equal(document.activeElement, button("Review runs"))
  assert.equal(root.querySelector(".routines-instructions"), null)
  emit({ ...retry, snapshot: original })
  assert.equal(root.querySelector(".routines-instructions"), null)
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  button("Review runs").click()
  await Promise.resolve()
  emit({ type: "routineState", agents: [] })
  await Promise.resolve()
  assert.equal(root.querySelector(".routines-instructions"), null)
  assert.equal(document.activeElement, root.querySelector(".routines-title"))
  emit({ type: "routineState", agents: [{ ...agent, execution: { state: "recovery" } }] })
  emit({ type: "routineRuns", agentID: "routine", runs: [] })
  assert.equal(
    [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Review runs"),
    false,
  )
  emit({ type: "routineState", agents: [{ ...agent, execution: { state: "recovery", runID: "orphan" } }] })
  button("Review runs").click()
  const orphan = sent.findLast((msg) => msg.type === "routineSnapshot")
  assert.equal(orphan.runID, "orphan")
  assert.match(root.textContent, /Run without saved history/)
  assert.match(root.textContent, /Run history has not been recorded/)
  assert.equal(
    [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Open conversation"),
    false,
  )
  emit({ ...orphan, snapshot: { ...original, runID: "orphan" } })
  assert.match(root.textContent, /Original <script>/)
  emit({ type: "routineRuns", agentID: "routine", runs: [{ id: "past", at: 1234, status: "complete" }] })
  const choices = root.querySelector(".routines-instructions select")
  choices.value = "past"
  choices.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(sent.findLast((msg) => msg.type === "routineSnapshot").runID, "past")
  choices.value = "orphan"
  choices.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(sent.findLast((msg) => msg.type === "routineSnapshot").runID, "orphan")
  root
    .querySelector(".routines-instructions")
    .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await Promise.resolve()
  assert.equal(root.querySelector(".routines-instructions"), null)
  assert.equal(document.activeElement, button("Review runs"))
  emit({ type: "routineState", agents: [{ ...agent, execution: { state: "recovery" } }] })
  assert.equal(button("Needs review").disabled, true)
  assert.equal(root.querySelector(".routines-identity").disabled, false)
  assert.doesNotMatch(root.textContent, /No saved goal is available/)
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  emit({ type: "routineState", agents: [agent] })
  button("Edit schedule").click()
  assert.match(root.textContent, /Saving keeps it paused/)
  assert.equal(button("Save assignment").disabled, true)
  button("Preview schedule").click()
  const first = sent.findLast((msg) => msg.type === "routineForecast")
  assert.deepEqual(first.edit, { agentID: "routine", expectedSchedule: agent.schedule, expectedScheduleVersion: 4 })
  const time = root.querySelector('input[type="time"]')
  time.value = "10:00"
  time.dispatchEvent(new window.Event("input", { bubbles: true }))
  emit({
    type: "routineForecast",
    requestID: first.requestID,
    forecastID: "stale",
    schedule: first.schedule,
    occurrences: [],
  })
  assert.equal(button("Save assignment").disabled, true)
  button("Preview schedule").click()
  const second = sent.findLast((msg) => msg.type === "routineForecast")
  emit({
    type: "routineForecast",
    requestID: second.requestID,
    forecastID: "current",
    schedule: second.schedule,
    occurrences: [Date.now() + 3600_000],
  })
  assert.equal(button("Confirm schedule change").disabled, false)
  button("Confirm schedule change").click()
  const save = sent.findLast((msg) => msg.type === "routineScheduleUpdate")
  assert.equal(save.agentID, "routine")
  assert.equal(save.forecastID, "current")
  assert.equal(root.querySelector("fieldset.routines-schedule").disabled, true)
  emit({ type: "routineState", saved: true, agents: [agent] })
  assert.match(root.textContent, /Edit schedule/)
  emit({ type: "routineScheduleUpdated", requestID: "unrelated", agentID: "routine" })
  assert.ok(button("Saving").disabled)
  emit({
    type: "routineScheduleUpdated",
    requestID: save.requestID,
    agentID: "routine",
    error: "Schedule version changed",
  })
  emit({ type: "routineState", agents: [agent] })
  assert.match(root.textContent, /Schedule version changed/)
  assert.equal(button("Save assignment").disabled, true)
  button("Back to routines to reload").click()
  assert.ok(sent.findLast((msg) => msg.type === "routineList"))
  {
    const occ = {
      id: "occ_live",
      agentID: "routine",
      sessionID: "ses_live",
      at: 1,
      status: "running",
    }
    const active = {
      ...agent,
      enabled: true,
      execution: { state: "active", sessionID: "ses_live", runID: "occ_live" },
    }
    emit({ type: "routineState", agents: [active] })
    emit({ type: "routineRuns", agentID: "routine", runs: [occ] })
    assert.match(root.textContent, /Pausing stops later starts/)
    assert.match(root.textContent, /The current run continues until it settles/)
    const starts = sent.filter((msg) => msg.type === "routineRun" || msg.type === "routineStop").length
    button("Edit schedule").click()
    assert.match(root.textContent, /Existing runs continue/)
    assert.match(root.textContent, /after unfinished work settles/)
    assert.doesNotMatch(root.textContent, /Saving keeps it paused/)
    button("Preview schedule").click()
    const preview = sent.findLast((msg) => msg.type === "routineForecast")
    emit({
      type: "routineForecast",
      requestID: preview.requestID,
      forecastID: "live-run",
      schedule: preview.schedule,
      occurrences: [Date.now() + 3600_000],
    })
    button("Confirm schedule change").click()
    const change = sent.findLast((msg) => msg.type === "routineScheduleUpdate")
    assert.equal(change.agentID, "routine")
    assert.equal(
      sent.filter((msg) => msg.type === "routineRun" || msg.type === "routineStop").length,
      starts,
      "Saving a schedule must not start or stop the current run",
    )
    emit({ type: "routineScheduleUpdated", requestID: change.requestID, agentID: "routine" })
    emit({ type: "routineState", agents: [{ ...active, enabled: false }] })
    emit({ type: "routineRuns", agentID: "routine", runs: [occ] })
    assert.match(root.textContent, /The current run continues until it settles/)
    button("Edit schedule").click()
    assert.match(root.textContent, /Existing runs continue/)
    assert.match(root.textContent, /This worker stays paused/)
    button("Done").click()
  }
  {
    button("Edit schedule").click()
    assert.match(root.textContent, /Earlier reports stay in this conversation/)
    const named = [...root.querySelectorAll("label")]
      .find((item) => item.textContent.trim().startsWith("Name"))
      .querySelector("input")
    const job = [...root.querySelectorAll("label")]
      .find((item) => item.textContent.trim().startsWith("Standing job"))
      .querySelector("textarea")
    assert.equal(named.value, "Review")
    assert.equal(job.value, "Review changes")
    named.value = "Accounting"
    named.dispatchEvent(new window.Event("input", { bubbles: true }))
    job.value = "Reconcile Friday receipts"
    job.dispatchEvent(new window.Event("input", { bubbles: true }))
    const prior = sent.filter((msg) => msg.type === "routineForecast").length
    button("Save assignment").click()
    assert.equal(sent.filter((msg) => msg.type === "routineForecast").length, prior)
    const saved = sent.findLast((msg) => msg.type === "routineUpdate")
    assert.equal(saved.agentID, "routine")
    assert.equal(saved.name, "Accounting")
    assert.equal(saved.objective, "Reconcile Friday receipts")
    assert.equal(saved.role, "reviewer")
    assert.equal(saved.dir, undefined)
    assert.equal(saved.mode, "chat")
    assert.equal(saved.plan, "")
    assert.equal(saved.capabilities, undefined)
    assert.equal(saved.enabled, undefined)
    emit({
      type: "routineState",
      saved: true,
      agents: [{ ...agent, name: "Accounting", objective: "Reconcile Friday receipts" }],
    })
    assert.equal(
      [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Save assignment"),
      false,
    )
    assert.match(root.textContent, /Accounting/)
  }
  {
    button("Edit schedule").click()
    assert.match(root.textContent, /Role/)
    assert.match(root.textContent, /Write folder/)
    assert.match(root.textContent, /Role, write folder, agent, and plan file/)
    assert.match(root.textContent, /cannot write in parent folders/)
    const dest = root.querySelector(".routines-pick input")
    assert.equal(dest.value, "")
    dest.value = "C:/tmp/review-writes"
    dest.dispatchEvent(new window.Event("input", { bubbles: true }))
    button("Save assignment").click()
    const assigned = sent.findLast((msg) => msg.type === "routineUpdate")
    assert.equal(assigned.agentID, "routine")
    assert.equal(assigned.role, "reviewer")
    assert.equal(assigned.dir, "C:/tmp/review-writes")
    assert.equal(assigned.mode, "chat")
    assert.equal(assigned.plan, "")
    assert.equal(assigned.capabilities, undefined)
    emit({
      type: "routineState",
      saved: true,
      agents: [{ ...agent, name: "Accounting", objective: "Reconcile Friday receipts", dir: assigned.dir }],
    })
    assert.equal(
      [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Save assignment"),
      false,
    )
  }
  {
    button("Edit schedule").click()
    assert.match(root.textContent, /Agent/)
    assert.match(root.textContent, /Plan file/)
    assert.match(root.textContent, /agent, and plan file/)
    const file = [...root.querySelectorAll("label")]
      .find((item) => item.textContent.trim().startsWith("Plan file"))
      .querySelector("input")
    assert.equal(file.value, "")
    file.value = "plans/friday.md"
    file.dispatchEvent(new window.Event("input", { bubbles: true }))
    button("Save assignment").click()
    const planned = sent.findLast((msg) => msg.type === "routineUpdate")
    assert.equal(planned.agentID, "routine")
    assert.equal(planned.plan, "plans/friday.md")
    assert.equal(planned.mode, "chat")
    emit({
      type: "routineState",
      saved: true,
      agents: [
        {
          ...agent,
          name: "Accounting",
          objective: "Reconcile Friday receipts",
          dir: "C:/tmp/review-writes",
          plan: planned.plan,
        },
      ],
    })
    assert.equal(
      [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Save assignment"),
      false,
    )
  }
  {
    button("Review access").click()
    await Promise.resolve()
    assert.match(root.textContent, /Writable location: C:\/tmp\/review-writes/)
    assert.match(root.textContent, /cannot write in parent folders/)
    assert.match(root.textContent, /Shell is not confined/)
    button("Close access review").click()
    await Promise.resolve()
  }
  const legacy = { ...agent, enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" } }
  emit({ type: "routineState", agents: [legacy] })
  assert.match(root.textContent, /Automatic runs need timezone review/)
  button("Edit schedule").click()
  assert.match(root.textContent, /Automatic runs are held until/)
  const zone = [...root.querySelectorAll("label")]
    .find((label) => label.textContent.includes("Calendar timezone"))
    .querySelector("input")
  assert.equal(zone.value, "")
  const before = sent.filter((msg) => msg.type === "routineForecast").length
  button("Preview schedule").click()
  assert.equal(sent.filter((msg) => msg.type === "routineForecast").length, before)
  assert.match(root.textContent, /Choose a timezone/)
  assert.equal(button("Save assignment").disabled, true)
  zone.value = "America/Toronto"
  zone.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Preview schedule").click()
  const reviewed = sent.findLast((msg) => msg.type === "routineForecast")
  assert.equal(reviewed.schedule.tz, "America/Toronto")
  assert.deepEqual(reviewed.edit.expectedSchedule, legacy.schedule)
  emit({
    type: "routineForecast",
    requestID: reviewed.requestID,
    forecastID: "zone-reviewed",
    schedule: reviewed.schedule,
    occurrences: [Date.now() + 3600_000],
  })
  assert.match(root.textContent, /Recurring work not already queued is skipped once it is a minute late/)
  assert.match(root.textContent, /repeated local times can produce two occurrences/)
  button("Confirm schedule change").click()
  const zoned = sent.findLast((msg) => msg.type === "routineScheduleUpdate")
  assert.equal(zoned.forecastID, "zone-reviewed")
  emit({ type: "routineScheduleUpdated", requestID: zoned.requestID, agentID: legacy.id })
  const fresh = { ...agent, scheduleVersion: 5, schedule: { kind: "once", at: Date.now() + 60_000 } }
  emit({ type: "routineState", agents: [fresh] })
  button("Edit schedule").click()
  const count = sent.filter((msg) => msg.type === "routineForecast").length
  const date = root.querySelector('input[type="datetime-local"]')
  assert.ok(date.value)
  date.value = ""
  date.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Preview schedule").click()
  assert.equal(sent.filter((msg) => msg.type === "routineForecast").length, count)
  assert.match(root.textContent, /calendar date and time/)
  date.value = "2027-07-10T09:00"
  date.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Preview schedule").click()
  const third = sent.findLast((msg) => msg.type === "routineForecast")
  assert.equal(third.edit.expectedScheduleVersion, 5)
  assert.deepEqual(third.edit.expectedSchedule, fresh.schedule)
  assert.equal(third.schedule.kind, "local")
  assert.equal(third.schedule.local, "2027-07-10T09:00")
  const resolved = { kind: "once", at: Date.parse("2027-07-10T13:00:00Z") }
  emit({
    type: "routineForecast",
    requestID: third.requestID,
    forecastID: "one-shot",
    schedule: resolved,
    occurrences: [resolved.at],
    timezone: "America/Toronto",
  })
  assert.match(root.textContent, /Timezone: America\/Toronto/)
  button("Confirm schedule change").click()
  const final = sent.findLast((msg) => msg.type === "routineScheduleUpdate")
  emit({ type: "routineScheduleUpdated", requestID: final.requestID, agentID: "another-routine" })
  assert.ok(button("Saving").disabled)
  emit({ type: "routineScheduleUpdated", requestID: final.requestID, agentID: "routine" })
  assert.equal(root.querySelector("form"), null)
  assert.equal(root.querySelector("h2").textContent, "Routines")
  {
    const archive = root.querySelector(".routines-archive")
    archive.open = true
    archive.dispatchEvent(new window.Event("toggle"))
    const listing = sent.findLast((msg) => msg.type === "routineArchive")
    assert.ok(listing.requestID)
    emit({
      type: "routineArchive",
      requestID: "stale",
      archive: [{ definition: { id: "wrong", name: "Stale archive" } }],
    })
    assert.doesNotMatch(archive.textContent, /Stale archive/)
    emit({
      type: "routineArchive",
      requestID: listing.requestID,
      next: "archived",
      archive: [
        {
          version: 1,
          archivedAt: 1234,
          definition: { id: "archived", name: "Removed review", objective: "<script>retained</script>" },
        },
      ],
    })
    const picker = archive.querySelector("select")
    picker.value = "archived"
    picker.dispatchEvent(new window.Event("change", { bubbles: true }))
    const interrupted = sent.findLast((msg) => msg.type === "routineArchive")
    archive.open = false
    archive.dispatchEvent(new window.Event("toggle"))
    emit({ type: "routineArchive", requestID: interrupted.requestID, agentID: "archived", runs: [], messages: [] })
    assert.doesNotMatch(archive.textContent, /No retained run history/)
    archive.open = true
    archive.dispatchEvent(new window.Event("toggle"))
    const selected = sent.findLast((msg) => msg.type === "routineArchive")
    assert.notEqual(selected.requestID, interrupted.requestID)
    assert.equal(selected.agentID, "archived")
    assert.equal(archive.querySelector("script"), null)
    emit({ type: "routineArchive", requestID: selected.requestID, agentID: "another", runs: [], messages: [] })
    assert.match(archive.textContent, /Loading archive/)
    emit({ type: "routineArchive", requestID: selected.requestID, agentID: "archived", error: "Archive unavailable" })
    assert.match(archive.textContent, /Archive unavailable/)
    button("Retry archive").click()
    const retry = sent.findLast((msg) => msg.type === "routineArchive")
    assert.notEqual(retry.requestID, selected.requestID)
    emit({ type: "routineArchive", requestID: selected.requestID, agentID: "archived", runs: [], messages: [] })
    assert.match(archive.textContent, /Loading archive/)
    emit({
      type: "routineArchive",
      requestID: retry.requestID,
      agentID: "archived",
      runs: [
        {
          id: "retained-run",
          agentID: "archived",
          at: 1234,
          status: "complete",
          sessionID: "retained-session",
          outcome: { summary: "Saved result" },
        },
      ],
      messages: [
        {
          id: "rmg_friday",
          agentID: "archived",
          kind: "report",
          source: "report:occ_1",
          body: "Friday receipts are missing.",
          time: 1234,
        },
      ],
    })
    const starts = sent.filter((msg) => msg.type === "routineRun" || msg.type === "routineCreate").length
    assert.match(archive.textContent, /Friday receipts are missing/)
    assert.match(archive.textContent, /Report/)
    button("Review retained runs").click()
    assert.match(archive.textContent, /Saved result/)
    assert.match(archive.textContent, /Criterion outcomes were not recorded/)
    assert.equal(sent.findLast((msg) => msg.type === "routineSnapshot").agentID, "archived")
    button("Open conversation").click()
    assert.equal(opened.at(-1), "retained-session")
    button("Close review").click()
    await Promise.resolve()
    assert.equal(document.activeElement, button("Review retained runs"))
    assert.equal(sent.filter((msg) => msg.type === "routineRun" || msg.type === "routineCreate").length, starts)
    button("Load more removed routines").click()
    const page = sent.findLast((msg) => msg.type === "routineArchive")
    assert.equal(page.cursor, "archived")
    assert.equal(page.agentID, undefined)
    assert.equal(picker.value, "archived")
    archive.open = false
    archive.dispatchEvent(new window.Event("toggle"))
    archive.open = true
    archive.dispatchEvent(new window.Event("toggle"))
    const resumed = sent.findLast((msg) => msg.type === "routineArchive")
    assert.notEqual(resumed.requestID, page.requestID)
    assert.equal(resumed.cursor, "archived")
    emit({ type: "routineArchive", requestID: page.requestID, archive: [] })
    assert.match(archive.textContent, /Loading archive/)
    emit({
      type: "routineArchive",
      requestID: resumed.requestID,
      archive: [
        {
          version: 1,
          archivedAt: 1234,
          definition: { id: "archived", name: "Removed review", objective: "<script>retained</script>" },
        },
        { version: 1, archivedAt: 1000, definition: { id: "older", name: "Older routine", objective: "Earlier work" } },
      ],
    })
    assert.equal(picker.options.length, 3)
    assert.equal(picker.value, "archived")
    assert.doesNotMatch(archive.textContent, /Load more removed routines/)
    button("Refresh archive").click()
    const refresh = sent.findLast((msg) => msg.type === "routineArchive")
    emit({ type: "routineArchive", requestID: refresh.requestID, archive: [] })
    assert.match(archive.textContent, /No removed routines have been archived/)
    assert.doesNotMatch(archive.textContent, /Saved result/)
    button("Refresh archive").click()
    const cancelled = sent.findLast((msg) => msg.type === "routineArchive")
    archive.open = false
    archive.dispatchEvent(new window.Event("toggle"))
    archive.open = true
    archive.dispatchEvent(new window.Event("toggle"))
    const expired = sent.findLast((msg) => msg.type === "routineArchive")
    assert.notEqual(expired.requestID, cancelled.requestID)
    assert.equal(expired.agentID, undefined)
    await new Promise((resolve) => setTimeout(resolve, 15_100))
    assert.match(archive.textContent, /archive request took too long/)
    emit({
      type: "routineArchive",
      requestID: expired.requestID,
      archive: [{ definition: { id: "late", name: "Late reply" } }],
    })
    assert.doesNotMatch(archive.textContent, /Late reply/)
    button("Retry archive").click()
    const renewed = sent.findLast((msg) => msg.type === "routineArchive")
    assert.notEqual(renewed.requestID, expired.requestID)
    emit({ type: "routineArchive", requestID: renewed.requestID, archive: [] })
    assert.match(archive.textContent, /No removed routines have been archived/)
    assert.doesNotMatch(archive.textContent, /archive request took too long/)
  }
  {
    emit({
      type: "routineState",
      agents: [agent],
      templates: [
        {
          id: "accountant",
          name: "Accountant starter",
          role: "accountant",
          objective: "Reconcile records",
          capabilities: ["money"],
          schedule: { kind: "manual" },
        },
        {
          id: "inbox",
          name: "Inbox starter",
          role: "inbox",
          objective: "Draft replies",
          capabilities: ["messages"],
          schedule: { kind: "manual" },
        },
      ],
    })
    button("Assign").click()
    button("Accountant starter").click()
    const money = root.querySelector('.routines-consent input[type="checkbox"]')
    assert.equal(money.checked, false)
    assert.match(root.textContent, /Read and report/)
    money.click()
    assert.equal(money.checked, true)
    const previous = [...root.querySelectorAll("label")]
      .find((item) => item.textContent.trim() === "Required output")
      .querySelector("textarea")
    previous.value = "Previous template deliverable"
    previous.dispatchEvent(new window.Event("input", { bubbles: true }))
    button("Inbox starter").click()
    assert.equal(
      [...root.querySelectorAll("label")]
        .find((item) => item.textContent.trim() === "Required output")
        .querySelector("textarea").value,
      "",
    )
    const messages = root.querySelector('.routines-consent input[type="checkbox"]')
    assert.equal(messages.checked, false)
    const directory = root.querySelector('input[placeholder="Choose or type a folder"]')
    directory.value = "C:/workspace"
    directory.dispatchEvent(new window.Event("input", { bubbles: true }))
    button("Preview schedule").click()
    const preview = sent.findLast((msg) => msg.type === "routineForecast")
    emit({
      type: "routineForecast",
      requestID: preview.requestID,
      forecastID: "consent-preview",
      schedule: { kind: "manual" },
      occurrences: [],
    })
    assert.equal(button("Confirm and assign").disabled, true)
    const count = sent.filter((msg) => msg.type === "routineCreate").length
    root.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    assert.equal(sent.filter((msg) => msg.type === "routineCreate").length, count)
    assert.match(root.textContent, /Choose whether to allow the records/)
    messages.click()
    assert.equal(button("Confirm and assign").disabled, true)
    root.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    assert.match(root.textContent, /Describe the required output/)
    assert.equal(sent.filter((msg) => msg.type === "routineCreate").length, count)
    const field = (label) =>
      [...root.querySelectorAll("label")].find((item) => item.textContent.trim() === label)?.querySelector("textarea")
    const fill = (label, value) => {
      const input = field(label)
      assert.ok(input)
      input.value = value
      input.dispatchEvent(new window.Event("input", { bubbles: true }))
    }
    fill("Required output", "Reply drafts in this conversation")
    fill("What must be true?", "Every draft identifies its source message")
    fill("How should Raya verify it?", "Include a message reference for each draft")
    assert.equal(button("Remove criterion 1").disabled, true)
    button("Add criterion").click()
    await Promise.resolve()
    assert.equal(document.activeElement?.closest("fieldset")?.querySelector("legend")?.textContent, "Criterion 2")
    assert.equal(button("Confirm and assign").disabled, true)
    button("Remove criterion 2").click()
    await Promise.resolve()
    assert.equal(document.activeElement === button("Add criterion"), true)
    assert.equal(button("Confirm and assign").disabled, false)
    button("Confirm and assign").click()
    const creation = sent.findLast((msg) => msg.type === "routineCreate")
    assert.equal(creation.role, "inbox")
    assert.deepEqual(creation.capabilities, ["messages"])
    assert.equal(creation.access, "brief")
    assert.equal(creation.output.destination, "conversation")
    assert.equal(creation.output.description, "Reply drafts in this conversation")
    assert.equal(creation.output.criteria.length, 1)
    assert.match(creation.output.criteria[0].id, /^criterion-/)
    assert.equal(creation.output.criteria[0].verification, "Include a message reference for each draft")
  }
} catch (err) {
  console.error(err)
  throw err
} finally {
  dispose()
  await window.happyDOM.close()
}
