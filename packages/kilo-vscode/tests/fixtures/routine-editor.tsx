import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window()
Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement })
const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { ScheduleEditor } = await import("../../webview-ui/src/components/routines/ScheduleEditor")
const { compile, initial } = await import("../../src/shared/routine-schedule")

const [draft, setDraft] = createSignal(initial("America/Toronto"))
const root = document.createElement("div")
document.body.append(root)
const dispose = render(() => <ScheduleEditor value={draft()} onChange={setDraft} />, root)
try {
  const mode = root.querySelector<HTMLSelectElement>("select")!
  assert.equal(mode.labels?.[0]?.textContent?.trim().startsWith("Repeat"), true)
  assert.equal(root.querySelectorAll('input[type="checkbox"]:checked').length, 5)
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    input.checked = input.labels?.[0]?.textContent?.trim() === "Monday"
    input.dispatchEvent(new window.Event("change", { bubbles: true }))
  }
  const time = root.querySelector<HTMLInputElement>('input[type="time"]')!
  time.value = "09:30"
  time.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.deepEqual(compile(draft()), { kind: "cron", expr: "30 9 * * 1", tz: "America/Toronto" })

  mode.value = "monthly"
  mode.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(root.querySelectorAll('input[type="checkbox"]').length, 0)
  const day = root.querySelector<HTMLInputElement>('input[type="number"]')!
  day.value = "31"
  day.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.deepEqual(compile(draft()), { kind: "cron", expr: "30 9 31 * *", tz: "America/Toronto" })
  assert.match(root.textContent ?? "", /Months without this date are skipped/)

  mode.value = "once"
  mode.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(root.querySelectorAll('input[type="time"]').length, 0)
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
    assert.equal(control.labels?.length, 1, "Every control has one associated label")
  }
  mode.value = "date"
  mode.dispatchEvent(new window.Event("change", { bubbles: true }))
  const date = root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  date.value = "2026-11-01T01:30"
  date.dispatchEvent(new window.Event("input", { bubbles: true }))
  const fold = Array.from(root.querySelectorAll<HTMLSelectElement>("select")).find((item) =>
    item.labels?.[0]?.textContent?.includes("clock repeats"),
  )!
  fold.value = "later"
  fold.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.deepEqual(compile(draft()), { kind: "local", local: "2026-11-01T01:30", tz: "America/Toronto", fold: "later" })
  assert.equal(root.querySelectorAll('input[type="time"]').length, 0)
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))
    assert.equal(control.labels?.length, 1)
  mode.value = "manual"
  mode.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(root.querySelectorAll("input").length, 0)
  assert.deepEqual(compile(draft()), { kind: "manual" })
} finally {
  dispose()
  await window.happyDOM.close()
}
