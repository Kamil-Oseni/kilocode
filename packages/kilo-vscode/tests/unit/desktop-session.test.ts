import { describe, expect, it } from "bun:test"
import {
  CAPTURE,
  DesktopSession,
  type DesktopAction,
  type DesktopDriver,
  type DesktopWindow,
} from "../../src/services/computer-use/desktop-session"

class Driver implements DesktopDriver {
  target = { windowID: "window-1", location: "Editor" }
  frame = {
    width: 1280,
    height: 720,
    mime: "image/png" as const,
    data: "png",
    timing: { acquisitionMs: 5, preparationMs: 7, totalMs: 20 },
  }
  readonly actions: DesktopAction[] = []
  readonly focused: string[] = []
  list: DesktopWindow[] = [
    {
      windowID: "window-1",
      location: "pid:5;class:Editor;title:Editor",
      title: "Editor",
      processID: 5,
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      minimized: false,
      foreground: true,
    },
  ]
  cancelled = 0

  async observe() {
    return { ...this.target, ...this.frame }
  }

  async current() {
    return { ...this.target }
  }

  async windows() {
    return this.list.map((window) => ({ ...window }))
  }

  async focus(target: DesktopWindow) {
    this.focused.push(target.windowID)
  }

  async perform(action: DesktopAction) {
    this.actions.push(action)
  }

  cancel() {
    this.cancelled += 1
  }
}

describe("native desktop session boundary", () => {
  it("focuses one exact window from a fresh single-use catalog", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const catalog = await session.windows()

    expect(catalog.windows).toHaveLength(1)
    await session.focus("window-1", catalog.observation.id)
    await expect(session.focus("window-1", catalog.observation.id)).rejects.toThrow(/unknown or was already used/i)
    expect(driver.focused).toEqual(["window-1"])
  })

  it("refuses a changed window catalog before focus", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const catalog = await session.windows()
    driver.list[0] = { ...driver.list[0], title: "Different", location: "pid:5;class:Editor;title:Different" }

    await expect(session.focus("window-1", catalog.observation.id)).rejects.toThrow(/stale after navigation/i)
    expect(driver.focused).toEqual([])
  })

  it("refuses duplicate and oversized window catalogs", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    driver.list = [{ ...driver.list[0] }, { ...driver.list[0] }]
    await expect(session.windows()).rejects.toThrow(/duplicate identity/i)
    driver.list = Array.from({ length: 65 }, (_, index) => ({
      ...driver.list[0],
      windowID: `window-${index}`,
      location: `pid:${index};class:Editor;title:Editor ${index}`,
      title: `Editor ${index}`,
      processID: index,
    }))
    await expect(session.windows()).rejects.toThrow(/64-window limit/i)
  })

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

  it("refuses oversized or over-encoded frames before issuing an observation", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    driver.frame = { ...driver.frame, width: CAPTURE.edge + 1, height: 1 }
    await expect(session.observe()).rejects.toThrow(/safe capture bounds/i)
    driver.frame = { ...driver.frame, width: CAPTURE.edge, height: CAPTURE.edge }
    await expect(session.observe()).rejects.toThrow(/safe capture bounds/i)
    driver.frame = { ...driver.frame, width: 1280, height: 720, data: "x".repeat(CAPTURE.data + 1) }
    await expect(session.observe()).rejects.toThrow(/encoded image limit/i)
    driver.frame = {
      ...driver.frame,
      data: "png",
      timing: { acquisitionMs: 10, preparationMs: 20, totalMs: 15 },
    }
    await expect(session.observe()).rejects.toThrow(/timing is invalid/i)

    driver.frame = {
      width: 1280,
      height: 720,
      mime: "image/png",
      data: "png",
      timing: { acquisitionMs: 5, preparationMs: 7, totalMs: 20 },
    }
    const frame = await session.observe()
    await session.execute({
      operation: "key",
      windowID: frame.windowID,
      observationID: frame.observation.id,
      key: "Enter",
    })
    expect(driver.actions).toHaveLength(1)
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
    await expect(
      session.execute({
        operation: "scroll",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        deltaX: 0,
        deltaY: 0,
      }),
    ).rejects.toThrow(/non-zero movement/i)
    await expect(
      session.execute({
        operation: "scroll",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        deltaX: 0,
        deltaY: 1_201,
      }),
    ).rejects.toThrow(/-1200 through 1200/i)
    await expect(
      session.execute({
        operation: "drag",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        startX: 0.5,
        startY: 0.5,
        endX: 0.5,
        endY: 0.5,
        button: "left",
      }),
    ).rejects.toThrow(/different start and end points/i)
    expect(driver.actions).toEqual([])
  })

  it("exposes manual takeover and requires a fresh observation after resume", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const states: string[] = []
    session.onState((state) => states.push(`${state.control}:${state.busy}:${state.reason ?? ""}`))
    const stale = await session.observe()
    const catalog = await session.windows()

    session.takeControl()
    await expect(session.focus("window-1", catalog.observation.id)).rejects.toThrow(/resume agent desktop control/i)
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
