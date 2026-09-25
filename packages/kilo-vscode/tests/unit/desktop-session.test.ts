import { describe, expect, it } from "bun:test"
import {
  CAPTURE,
  DesktopSession,
  type DesktopAction,
  type DesktopDriver,
  type DesktopDispatchTarget,
  type DesktopFrame,
  type DesktopWindow,
} from "../../src/services/computer-use/desktop-session"

class Driver implements DesktopDriver {
  target = { windowID: "window-1", location: "Editor" }
  frame: Omit<DesktopFrame, "windowID" | "location"> = {
    width: 1280,
    height: 720,
    mime: "image/png" as const,
    data: "png",
    timing: { acquisitionMs: 5, preparationMs: 7, totalMs: 20 },
  }
  readonly actions: DesktopAction[] = []
  readonly targets: DesktopDispatchTarget[] = []
  readonly frames: DesktopFrame[] = []
  readonly fresh: boolean[] = []
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

  async observe(options?: { fresh?: boolean }) {
    this.fresh.push(options?.fresh === true)
    const next = this.frames.shift()
    if (next) return next
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

  async perform(action: DesktopAction, target: DesktopDispatchTarget) {
    this.actions.push(action)
    this.targets.push(target)
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
      sensitive: false,
      x: 0.5,
      y: 0.25,
    }

    await session.execute(action)
    await expect(session.execute(action)).rejects.toThrow(/unknown or was already used/i)
    expect(driver.actions).toEqual([action])
    expect(driver.targets[0]).toMatchObject({
      windowID: frame.windowID,
      location: frame.location,
      scene: frame.observation.sequence,
      observedAt: frame.observation.observedAt,
      validUntil: frame.observation.observedAt + 10_000,
    })
  })

  it("consumes and refuses a misclassified accessible sensitive target before native dispatch", async () => {
    const driver = new Driver()
    driver.frame = {
      ...driver.frame,
      semantics: {
        source: "windows_ui_automation",
        status: "available",
        viewport: { x: 0, y: 0, width: 1280, height: 720 },
        controls: [
          {
            controlID: "send",
            role: "Button",
            name: "Send message",
            x: 576,
            y: 324,
            width: 128,
            height: 72,
            enabled: true,
            focused: false,
            actions: ["invoke"],
          },
        ],
        truncated: false,
      },
    }
    const session = new DesktopSession(driver)
    const frame = await session.observe()
    const action: DesktopAction = {
      operation: "pointer",
      action: "click",
      windowID: frame.windowID,
      observationID: frame.observation.id,
      sensitive: false,
      x: 0.5,
      y: 0.5,
    }

    await expect(session.execute(action)).rejects.toThrow(/sensitive_category=communications/i)
    await expect(session.execute({ ...action, sensitive: "communications" })).rejects.toThrow(
      /unknown or was already used/i,
    )
    expect(driver.actions).toEqual([])
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
      ...driver.frame,
      semantics: {
        source: "windows_ui_automation",
        status: "available",
        viewport: { x: 0, y: 0, width: 1280, height: 720 },
        controls: [],
        truncated: false,
      },
      timing: { acquisitionMs: 50, preparationMs: 40, semanticsMs: 900, totalMs: 950 },
    }
    expect((await session.observe()).timing.totalMs).toBe(950)

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
      sensitive: false,
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
        sensitive: false,
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
        sensitive: false,
        x: 1.1,
        y: 0.5,
      }),
    ).rejects.toThrow(/normalized values/i)
    await expect(
      session.execute({
        operation: "scroll",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        sensitive: false,
        deltaX: 0,
        deltaY: 0,
      }),
    ).rejects.toThrow(/non-zero movement/i)
    await expect(
      session.execute({
        operation: "scroll",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        sensitive: false,
        deltaX: 0,
        deltaY: 1_201,
      }),
    ).rejects.toThrow(/-1200 through 1200/i)
    await expect(
      session.execute({
        operation: "drag",
        windowID: frame.windowID,
        observationID: frame.observation.id,
        sensitive: false,
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
        sensitive: false,
        key: "Enter",
      }),
    ).rejects.toThrow(/resume agent desktop control/i)
    session.resume()
    await expect(
      session.execute({
        operation: "key",
        windowID: stale.windowID,
        observationID: stale.observation.id,
        sensitive: false,
        key: "Enter",
      }),
    ).rejects.toThrow(/unknown or was already used/i)

    expect(driver.cancelled).toBe(1)
    expect(states).toEqual(["agent:false:", "manual:false:You took manual control of the desktop.", "agent:false:"])
  })

  it("discards capture and window results that finish after manual takeover", async () => {
    const capture = Promise.withResolvers<void>()
    const listing = Promise.withResolvers<void>()
    class Delayed extends Driver {
      override async observe() {
        await capture.promise
        return super.observe()
      }

      override async windows() {
        await listing.promise
        return super.windows()
      }
    }
    const driver = new Delayed()
    const session = new DesktopSession(driver)
    const results = Promise.allSettled([session.observe(), session.windows()])

    session.takeControl()
    capture.resolve()
    listing.resolve()

    const settled = await results
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(settled.map((result) => (result.status === "rejected" ? result.reason.message : ""))).toEqual([
      "Desktop observation cancelled after control changed",
      "Desktop window list cancelled after control changed",
    ])
    expect(driver.cancelled).toBe(1)
  })

  it("runs a bounded local sequence across advancing scene versions", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.frames.push(
      {
        ...driver.target,
        ...driver.frame,
        data: "focused",
        semantics: {
          source: "windows_ui_automation",
          status: "available",
          viewport: { x: 0, y: 0, width: 1280, height: 720 },
          controls: [
            {
              controlID: "editor",
              role: "Edit",
              x: 0,
              y: 0,
              width: 1280,
              height: 720,
              enabled: true,
              focused: true,
              actions: ["value"],
            },
          ],
          truncated: false,
        },
      },
      { ...driver.target, ...driver.frame, data: "typed" },
    )

    const result = await session.sequence({
      observationID: initial.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: {
            operation: "pointer",
            action: "click",
            windowID: "window-1",
            sensitive: false,
            x: 0.5,
            y: 0.5,
          },
          postconditions: [{ kind: "control", controlID: "editor", focused: true }],
          recovery: "stop",
        },
        {
          action: { operation: "type", windowID: "window-1", sensitive: false, text: "hello" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    })

    expect(result).toMatchObject({
      status: "completed",
      completed: 2,
      scene: { data: "typed", observation: { version: 2, sequence: 3, sceneVersion: 3 } },
    })
    expect(driver.actions.map((action) => action.operation)).toEqual(["pointer", "type"])
    expect(driver.actions[0]?.observationID).toBe(initial.observation.id)
    expect(driver.actions[1]?.observationID).not.toBe(initial.observation.id)
    expect(driver.targets.map((target) => target.scene)).toEqual([1, 2])
    expect(driver.targets.every((target) => target.validUntil - target.observedAt <= 10_000)).toBe(true)
    expect(driver.fresh).toEqual([false, true, true])
  })

  it("uses the guarded dispatch target without a second foreground lookup", async () => {
    class Guarded extends Driver {
      readonly guarded = true as const
      reads = 0

      override async current() {
        this.reads += 1
        return super.current()
      }

      override async perform(action: DesktopAction, target: { windowID: string; location?: string }) {
        if (target.windowID !== this.target.windowID || target.location !== this.target.location)
          throw new Error("Native guard refused a changed foreground target")
        this.actions.push(action)
      }
    }

    const driver = new Guarded()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.frames.push({ ...driver.target, ...driver.frame, data: "after" })
    const run = () =>
      session.sequence({
        observationID: initial.observation.id,
        maxDurationMs: 5_000,
        steps: [
          {
            action: { operation: "key", windowID: "window-1", sensitive: false, key: "Tab" },
            postconditions: [{ kind: "pixels", change: "changed" }],
            recovery: "stop",
          },
        ],
      })

    expect((await run()).status).toBe("completed")
    expect(driver.reads).toBe(0)
    expect(driver.actions).toHaveLength(1)

    const next = await session.observe()
    driver.target = { ...driver.target, location: "Different" }
    await expect(
      session.sequence({
        observationID: next.observation.id,
        maxDurationMs: 5_000,
        steps: [
          {
            action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
            postconditions: [{ kind: "pixels", change: "changed" }],
            recovery: "stop",
          },
        ],
      }),
    ).rejects.toThrow(/may have taken effect/i)
    expect(driver.reads).toBe(0)
    expect(driver.actions).toHaveLength(1)
  })

  it("does not accept a cached pre-action frame as a sequence postcondition", async () => {
    class Cached extends Driver {
      override async observe(options?: { fresh?: boolean }) {
        if (options?.fresh) return super.observe(options)
        this.fresh.push(false)
        return { ...this.target, ...this.frame, data: "cached" }
      }

      override async perform(action: DesktopAction) {
        await super.perform(action)
        this.frame = { ...this.frame, data: `after-${this.actions.length}` }
      }
    }

    const driver = new Cached()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    const result = await session.sequence({
      observationID: initial.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Tab" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    })

    expect(result).toMatchObject({ status: "completed", completed: 2, scene: { data: "after-2" } })
    expect(driver.fresh).toEqual([false, true, true])
  })

  it("stops a sequence before its next effect when a local postcondition fails", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.frames.push({ ...driver.target, ...driver.frame, data: initial.data })

    const result = await session.sequence({
      observationID: initial.observation.id,
      maxDurationMs: 5_000,
      steps: [
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Tab" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ],
    })

    expect(result).toMatchObject({ status: "stopped", completed: 1, reason: expect.stringMatching(/changed/i) })
    expect(driver.actions.map((action) => action.key)).toEqual(["Tab"])
  })

  it("refuses a sequence when the exact target changed before its first effect", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.target.location = "Different"

    await expect(
      session.sequence({
        observationID: initial.observation.id,
        maxDurationMs: 5_000,
        steps: [
          {
            action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
            postconditions: [{ kind: "pixels", change: "changed" }],
            recovery: "stop",
          },
        ],
      }),
    ).rejects.toThrow(/scene changed before dispatch/i)
    expect(driver.actions).toEqual([])
  })

  it("reports an uncertain sequence outcome without retry when post-effect capture fails", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.frames.push({ ...driver.target, ...driver.frame, data: "" })

    await expect(
      session.sequence({
        observationID: initial.observation.id,
        maxDurationMs: 5_000,
        steps: [
          {
            action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
            postconditions: [{ kind: "pixels", change: "changed" }],
            recovery: "stop",
          },
        ],
      }),
    ).rejects.toThrow(/sequence postcondition may have taken effect.*not retried/i)
    expect(driver.actions.map((action) => action.key)).toEqual(["Enter"])
  })

  it("reports a partial sequence without replay when a later lease check denies", async () => {
    const driver = new Driver()
    const session = new DesktopSession(driver)
    const initial = await session.observe()
    driver.frames.push({ ...driver.target, ...driver.frame, data: "first-effect" })
    let checks = 0

    await expect(
      session.sequence(
        {
          observationID: initial.observation.id,
          maxDurationMs: 5_000,
          steps: [
            {
              action: { operation: "key", windowID: "window-1", sensitive: false, key: "Tab" },
              postconditions: [{ kind: "pixels", change: "changed" }],
              recovery: "stop",
            },
            {
              action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
              postconditions: [{ kind: "pixels", change: "changed" }],
              recovery: "stop",
            },
          ],
        },
        () => {
          checks += 1
          if (checks === 2) throw new Error("Grant stopped")
        },
      ),
    ).rejects.toThrow(/partial sequence may have taken effect.*not retried/i)
    expect(driver.actions.map((action) => action.key)).toEqual(["Tab"])
  })
})
