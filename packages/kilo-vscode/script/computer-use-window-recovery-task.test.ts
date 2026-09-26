import { describe, expect, it } from "bun:test"
import { assess } from "./computer-use-window-recovery-task"

const task = { runId: "e986c01c-69da-4c93-a882-79392be8cb91", code: "A531D49C", expected: "North" as const }
const event = {
  runId: task.runId,
  pid: 4101,
  before: [120, 120, 440, 300],
  after: [257, 211, 555, 383],
  at: "2026-09-26T12:00:00.000Z",
}
const scene = {
  threadDesktop: "Default",
  inputDesktop: "Default",
  title: `Raya window recovery ${task.code}`,
  pid: 4101,
  processPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  foreground: true,
  bounds: event.after,
  names: [`North ${task.code}`, `South ${task.code}`, "Selected North; selections 1"],
}

describe("native moved and resized window task scorer", () => {
  it("accepts one randomized selection after confirmed move and resize", () => {
    expect(assess(task, event, scene).correctFinalState).toBe(true)
  })

  it("refuses an unchanged window or a missing external event", () => {
    expect(assess(task, { ...event, after: event.before }, scene).correctFinalState).toBe(false)
    expect(assess(task, undefined, scene).correctFinalState).toBe(false)
    expect(assess(task, { ...event, before: [120, 120, 555, 383] }, scene).correctFinalState).toBe(false)
  })

  it("refuses a stale or replaced window", () => {
    expect(assess(task, event, { ...scene, bounds: event.before }).correctFinalState).toBe(false)
    expect(assess(task, event, { ...scene, pid: 4102 }).correctFinalState).toBe(false)
    expect(assess(task, event, { ...scene, foreground: false }).correctFinalState).toBe(false)
  })

  it("refuses the wrong target and a duplicate effect", () => {
    expect(assess(task, event, { ...scene, names: ["Selected South; selections 1"] }).correctFinalState).toBe(false)
    expect(assess(task, event, { ...scene, names: ["Selected North; selections 2"] }).correctFinalState).toBe(false)
    expect(assess(task, event, { ...scene, names: ["Selected North; selections 10"] }).correctFinalState).toBe(false)
  })

  it("refuses a shell desktop different from the interactive desktop", () => {
    expect(assess(task, event, { ...scene, threadDesktop: "CodexSandboxDesktop-7" }).correctFinalState).toBe(false)
    expect(assess(task, event, { ...scene, inputDesktop: "CodexSandboxDesktop-7" }).correctFinalState).toBe(false)
  })
})
