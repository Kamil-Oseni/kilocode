import type { ComputerObservation } from "./observation-ledger"
import type { DesktopAction, DesktopFrame } from "./desktop-session"

export type DesktopPlannedAction<T = DesktopAction> = T extends DesktopAction ? Omit<T, "observationID"> : never

export type DesktopPostcondition =
  | { kind: "pixels"; change: "changed" | "unchanged" }
  | {
      kind: "control"
      controlID: string
      enabled?: boolean
      focused?: boolean
      selected?: boolean
    }

export type DesktopPrecondition = Exclude<DesktopPostcondition, { kind: "pixels" }>

export type DesktopSequenceStep = {
  action: DesktopPlannedAction
  preconditions?: DesktopPrecondition[]
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
  evidence: Array<{
    step: number
    observationID: string
    sceneVersion: number
    observedAt: number
    postconditions: DesktopPostcondition[]
  }>
}

export type DesktopSequenceInput = {
  scene: DesktopScene
  steps: DesktopSequenceStep[]
  maxDurationMs: number
}

export type DesktopSequenceRunner = {
  step(action: DesktopPlannedAction, scene: DesktopScene): Promise<DesktopScene>
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

function validate(input: DesktopSequenceInput): void {
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
}

export async function executeSequence(
  input: DesktopSequenceInput,
  runner: DesktopSequenceRunner,
): Promise<DesktopSequenceResult> {
  validate(input)

  const started = runner.now()
  let scene = input.scene
  let completed = 0
  const evidence: DesktopSequenceResult["evidence"] = []
  for (const step of input.steps) {
    const stopped = (reason: string): DesktopSequenceResult => ({
      status: "stopped",
      completed,
      reason,
      scene,
      evidence,
    })
    if ((step.preconditions?.length ?? 0) > 4)
      throw new Error("Every desktop sequence action supports at most 4 control preconditions")
    if (runner.cancelled()) return stopped("Desktop sequence was cancelled")
    if (runner.now() - started >= input.maxDurationMs) return stopped("Desktop sequence reached its maximum duration")
    if (step.action.windowID !== scene.observation.target.windowID)
      return stopped("Desktop sequence target window changed")
    for (const expected of step.preconditions ?? []) {
      const reason = postcondition(scene, scene, expected)
      if (reason) return stopped(reason.replace("Required desktop control", "Desktop precondition control"))
    }

    const before = scene
    scene = await runner.step(step.action, scene)
    completed += 1
    if (runner.cancelled()) return stopped("Desktop sequence was cancelled")
    if (runner.now() - started >= input.maxDurationMs) return stopped("Desktop sequence reached its maximum duration")
    if (scene.observation.target.windowID !== step.action.windowID)
      return stopped("Desktop sequence changed to an unexpected window")
    for (const expected of step.postconditions) {
      const reason = postcondition(before, scene, expected)
      if (reason) return stopped(reason)
    }
    evidence.push({
      step: completed,
      observationID: scene.observation.id,
      sceneVersion: scene.observation.sceneVersion,
      observedAt: scene.observation.observedAt,
      postconditions: step.postconditions,
    })
  }
  return { status: "completed", completed, scene, evidence }
}
