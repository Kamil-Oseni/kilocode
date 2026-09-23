import type { ComputerObservation } from "./observation-ledger"
import type { DesktopAction, DesktopFrame } from "./desktop-session"

type Planned<T = DesktopAction> = T extends DesktopAction ? Omit<T, "observationID"> : never

export type DesktopPostcondition =
  | { kind: "pixels"; change: "changed" | "unchanged" }
  | {
      kind: "control"
      controlID: string
      enabled?: boolean
      focused?: boolean
      selected?: boolean
    }

export type DesktopSequenceStep = {
  action: Planned
  postconditions: DesktopPostcondition[]
  recovery: "stop"
}

export type DesktopScene = DesktopFrame & {
  observation: ComputerObservation & { target: { surface: "desktop"; windowID: string; location?: string } }
}

export type DesktopSequenceResult = {
  status: "completed" | "stopped"
  completed: number
  reason?: string
  scene: DesktopScene
}

export type DesktopSequenceInput = {
  scene: DesktopScene
  steps: DesktopSequenceStep[]
  maxDurationMs: number
}

export type DesktopSequenceRunner = {
  step(action: Planned, scene: DesktopScene): Promise<DesktopScene>
  cancelled(): boolean
  now(): number
}

function postcondition(before: DesktopScene, after: DesktopScene, expected: DesktopPostcondition): string | undefined {
  if (expected.kind === "pixels") {
    const changed =
      before.width !== after.width ||
      before.height !== after.height ||
      before.mime !== after.mime ||
      before.data !== after.data
    if (changed === (expected.change === "changed")) return
    return `Expected desktop pixels to be ${expected.change}, but the local frame was ${changed ? "changed" : "unchanged"}`
  }
  if (!after.semantics || after.semantics.status !== "available")
    return "The required accessibility postcondition is unavailable"
  const control = after.semantics.controls.find((item) => item.controlID === expected.controlID)
  if (!control) return `Required desktop control ${expected.controlID} is no longer present`
  for (const state of ["enabled", "focused", "selected"] as const) {
    if (expected[state] === undefined) continue
    if (control[state] !== expected[state])
      return `Required desktop control ${expected.controlID} did not reach ${state}=${expected[state]}`
  }
}

export async function executeSequence(
  input: DesktopSequenceInput,
  runner: DesktopSequenceRunner,
): Promise<DesktopSequenceResult> {
  if (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs < 100 || input.maxDurationMs > 10_000)
    throw new Error("Desktop sequence duration must be from 100 through 10000 milliseconds")
  if (input.steps.length < 1 || input.steps.length > 8)
    throw new Error("Desktop sequence requires 1 through 8 bounded actions")
  if (
    input.steps.some(
      (step) => step.recovery !== "stop" || step.postconditions.length < 1 || step.postconditions.length > 4,
    )
  )
    throw new Error("Every desktop sequence action requires 1 through 4 stop-on-mismatch postconditions")

  const started = runner.now()
  let scene = input.scene
  let completed = 0
  for (const step of input.steps) {
    if (runner.cancelled()) return { status: "stopped", completed, reason: "Desktop sequence was cancelled", scene }
    if (runner.now() - started >= input.maxDurationMs)
      return { status: "stopped", completed, reason: "Desktop sequence reached its maximum duration", scene }
    if (step.action.windowID !== scene.observation.target.windowID)
      return { status: "stopped", completed, reason: "Desktop sequence target window changed", scene }

    const before = scene
    scene = await runner.step(step.action, scene)
    completed += 1
    if (runner.cancelled()) return { status: "stopped", completed, reason: "Desktop sequence was cancelled", scene }
    if (runner.now() - started >= input.maxDurationMs)
      return { status: "stopped", completed, reason: "Desktop sequence reached its maximum duration", scene }
    if (scene.observation.target.windowID !== step.action.windowID)
      return { status: "stopped", completed, reason: "Desktop sequence changed to an unexpected window", scene }
    for (const expected of step.postconditions) {
      const reason = postcondition(before, scene, expected)
      if (reason) return { status: "stopped", completed, reason, scene }
    }
  }
  return { status: "completed", completed, scene }
}
