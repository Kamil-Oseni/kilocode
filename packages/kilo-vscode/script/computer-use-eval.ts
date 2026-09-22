import {
  DesktopSession,
  type DesktopAction,
  type DesktopDriver,
  type DesktopFrame,
  type DesktopWindow,
} from "../src/services/computer-use/desktop-session"

type Result = {
  id: string
  passed: boolean
  expectedDispatches: number
  actualDispatches: number
  latencyMs: number
  refusal?: "changed-target" | "changed-catalog" | "replay" | "takeover"
  recovered?: boolean
  interventions: number
}

export type Report = {
  format: "raya.computer-use-evaluation"
  version: 1
  mode: "deterministic"
  scenarios: Result[]
  summary: {
    successRate: number
    unintendedDispatches: number
    staleFrameRefusals: number
    recoverySuccesses: number
    latencyP95Ms: number
    humanInterventions: number
    modelCostUsd: 0
  }
}

class Driver implements DesktopDriver {
  target = "window_1"
  location = "process|title|bounds"
  readonly actions: DesktopAction[] = []
  readonly focuses: string[] = []

  async observe(): Promise<DesktopFrame> {
    return {
      windowID: this.target,
      location: this.location,
      width: 20,
      height: 10,
      mime: "image/png",
      data: "cG5n",
    }
  }

  async current() {
    return { windowID: this.target, location: this.location }
  }

  async windows(): Promise<DesktopWindow[]> {
    return [
      {
        windowID: this.target,
        location: this.location,
        title: "Evaluation window",
        processID: 5,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        minimized: false,
        foreground: true,
      },
    ]
  }

  async focus(target: DesktopWindow): Promise<void> {
    this.focuses.push(target.windowID)
  }

  async perform(action: DesktopAction): Promise<void> {
    this.actions.push(action)
  }
}

async function refuse(task: Promise<void>, pattern: RegExp): Promise<boolean> {
  return task.then(
    () => false,
    (error) => pattern.test(error instanceof Error ? error.message : String(error)),
  )
}

async function measure(
  id: string,
  expected: number,
  run: (
    driver: Driver,
    session: DesktopSession,
  ) => Promise<Omit<Result, "id" | "expectedDispatches" | "actualDispatches" | "latencyMs">>,
): Promise<Result> {
  const driver = new Driver()
  const session = new DesktopSession(driver)
  const started = performance.now()
  const result = await run(driver, session)
  const latencyMs = Math.max(0, performance.now() - started)
  const actualDispatches = driver.actions.length + driver.focuses.length
  session.dispose()
  return { id, expectedDispatches: expected, actualDispatches, latencyMs, ...result }
}

export async function evaluate(): Promise<Report> {
  const scenarios = [
    await measure("grounded-window-focus", 1, async (_driver, session) => {
      const result = await session.windows()
      await session.focus(result.windows[0].windowID, result.observation.id)
      return { passed: true, interventions: 0 }
    }),
    await measure("changed-window-catalog-refusal", 0, async (driver, session) => {
      const result = await session.windows()
      driver.location = "process|changed-title|bounds"
      const denied = await refuse(
        session.focus(result.windows[0].windowID, result.observation.id),
        /stale after navigation/i,
      )
      return { passed: denied, refusal: "changed-catalog" as const, interventions: 0 }
    }),
    await measure("grounded-effect", 1, async (_driver, session) => {
      const frame = await session.observe()
      await session.execute({
        operation: "scroll",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        deltaX: 0,
        deltaY: 120,
      })
      return { passed: true, interventions: 0 }
    }),
    await measure("changed-target-refusal", 0, async (driver, session) => {
      const frame = await session.observe()
      driver.target = "window_2"
      const denied = await refuse(
        session.execute({
          operation: "scroll",
          windowID: frame.windowID,
          observationID: frame.observation.id,
          deltaX: 0,
          deltaY: 120,
        }),
        /different window/i,
      )
      return { passed: denied, refusal: "changed-target" as const, interventions: 0 }
    }),
    await measure("observation-replay-refusal", 1, async (_driver, session) => {
      const frame = await session.observe()
      const action = {
        operation: "key" as const,
        windowID: frame.windowID,
        observationID: frame.observation.id,
        key: "Enter",
      }
      await session.execute(action)
      const denied = await refuse(session.execute(action), /unknown or was already used/i)
      return { passed: denied, refusal: "replay" as const, interventions: 0 }
    }),
    await measure("takeover-and-recovery", 1, async (_driver, session) => {
      const stale = await session.observe()
      session.takeControl("Evaluation takeover")
      const denied = await refuse(
        session.execute({
          operation: "key",
          windowID: stale.windowID,
          observationID: stale.observation.id,
          key: "Enter",
        }),
        /resume agent desktop control/i,
      )
      session.resume()
      const fresh = await session.observe()
      await session.execute({
        operation: "key",
        windowID: fresh.windowID,
        observationID: fresh.observation.id,
        key: "Enter",
      })
      return { passed: denied, refusal: "takeover" as const, recovered: true, interventions: 1 }
    }),
  ]
  const latencies = scenarios.map((item) => item.latencyMs).sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1)
  const passed = scenarios.filter((item) => item.passed && item.actualDispatches === item.expectedDispatches).length
  return {
    format: "raya.computer-use-evaluation",
    version: 1,
    mode: "deterministic",
    scenarios,
    summary: {
      successRate: passed / scenarios.length,
      unintendedDispatches: scenarios.reduce(
        (total, item) => total + Math.max(0, item.actualDispatches - item.expectedDispatches),
        0,
      ),
      staleFrameRefusals: scenarios.filter(
        (item) => item.refusal === "changed-target" || item.refusal === "changed-catalog" || item.refusal === "replay",
      ).length,
      recoverySuccesses: scenarios.filter((item) => item.recovered && item.passed).length,
      latencyP95Ms: latencies[index] ?? 0,
      humanInterventions: scenarios.reduce((total, item) => total + item.interventions, 0),
      modelCostUsd: 0,
    },
  }
}

if (import.meta.main) {
  const report = await evaluate()
  console.log(JSON.stringify(report, undefined, 2))
  if (report.summary.successRate !== 1 || report.summary.unintendedDispatches !== 0) process.exitCode = 1
}
