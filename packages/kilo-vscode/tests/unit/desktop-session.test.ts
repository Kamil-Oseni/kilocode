import { describe, expect, it } from "bun:test"
import { DesktopSession, type DesktopAction, type DesktopDriver } from "../../src/services/computer-use/desktop-session"

class Driver implements DesktopDriver {
  target = { windowID: "window-1", location: "Editor" }
  readonly actions: DesktopAction[] = []
  cancelled = 0

  async observe() {
    return { ...this.target, width: 1280, height: 720, mime: "image/png" as const, data: "png" }
  }

  async current() {
    return { ...this.target }
  }

  async perform(action: DesktopAction) {
    this.actions.push(action)
  }

  cancel() {
    this.cancelled += 1
  }
}

describe("native desktop session boundary", () => {
  it("dispatches one exact observation-grounded action", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const frame = await session.observe()
    const action: DesktopAction = {
      operation: "pointer",
      action: "click",
      windowID: frame.windowID,
      observationID: frame.observation.id,
      x: 0.5,
      y: 0.25,
    }

    await session.execute(action)
    await expect(session.execute(action)).rejects.toThrow(/unknown or was already used/i)
    expect(driver.actions).toEqual([action])
  })

  it("refuses changed windows and invalid coordinates before dispatch", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const changed = await session.observe()
    driver.target.windowID = "window-2"
    await expect(
      session.execute({
        operation: "type",
        windowID: changed.windowID,
        observationID: changed.observation.id,
        text: "unsafe",
      }),
    ).rejects.toThrow(/different window/i)

    const frame = await session.observe()
    await expect(
      session.execute({
        operation: "pointer",
        action: "click",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        x: 1.1,
        y: 0.5,
      }),
    ).rejects.toThrow(/normalized values/i)
    expect(driver.actions).toEqual([])
  })

  it("exposes manual takeover and requires a fresh observation after resume", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const states: string[] = []
    session.onState((state) => states.push(`${state.control}:${state.busy}:${state.reason ?? ""}`))
    const stale = await session.observe()

    session.takeControl()
    await expect(
      session.execute({
        operation: "key",
        windowID: stale.windowID,
        observationID: stale.observation.id,
        key: "Enter",
      }),
    ).rejects.toThrow(/resume agent desktop control/i)
    session.resume()
    await expect(
      session.execute({
        operation: "key",
        windowID: stale.windowID,
        observationID: stale.observation.id,
        key: "Enter",
      }),
    ).rejects.toThrow(/unknown or was already used/i)

    expect(driver.cancelled).toBe(1)
    expect(states).toEqual(["agent:false:", "manual:false:You took manual control of the desktop.", "agent:false:"])
  })
})
