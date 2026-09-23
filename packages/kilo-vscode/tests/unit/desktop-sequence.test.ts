import { describe, expect, it } from "bun:test"
import {
  executeSequence,
  type DesktopScene,
  type DesktopSequenceInput,
} from "../../src/services/computer-use/desktop-sequence"

function scene(version: number, data: string, focused = false, windowID = "window-1"): DesktopScene {
  return {
    windowID,
    location: `scene-${version}`,
    width: 20,
    height: 10,
    mime: "image/png",
    data,
    timing: { acquisitionMs: 1, preparationMs: 1, semanticsMs: 1, totalMs: 3 },
    semantics: {
      source: "windows_ui_automation",
      status: "available",
      viewport: { x: 0, y: 0, width: 20, height: 10 },
      controls: [
        {
          controlID: "editor",
          role: "Edit",
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          enabled: true,
          focused,
          actions: ["value"],
        },
      ],
      truncated: false,
    },
    observation: {
      version: 2,
      id: `observation-${version}`,
      sequence: version,
      sceneVersion: version,
      observedAt: version,
      validUntil: 10_000,
      target: { surface: "desktop", windowID, location: `scene-${version}` },
    },
  }
}

function input(steps: DesktopSequenceInput["steps"]): DesktopSequenceInput {
  return { scene: scene(1, "first"), steps, maxDurationMs: 5_000 }
}

describe("bounded desktop sequence executor", () => {
  it("advances ordered actions only after local postconditions pass", async () => {
    const calls: string[] = []
    const frames = [scene(2, "second", true), scene(3, "second", true)]
    const result = await executeSequence(
      input([
        {
          action: {
            operation: "pointer",
            action: "click",
            windowID: "window-1",
            sensitive: false,
            x: 0.5,
            y: 0.5,
          },
          postconditions: [
            { kind: "pixels", change: "changed" },
            { kind: "control", controlID: "editor", focused: true },
          ],
          recovery: "stop",
        },
        {
          action: { operation: "type", windowID: "window-1", sensitive: false, text: "hello" },
          postconditions: [{ kind: "pixels", change: "unchanged" }],
          recovery: "stop",
        },
      ]),
      {
        step: async (action) => {
          calls.push(action.operation)
          return frames.shift()!
        },
        cancelled: () => false,
        now: () => 100,
      },
    )

    expect(result).toMatchObject({ status: "completed", completed: 2, scene: { observation: { sceneVersion: 3 } } })
    expect(calls).toEqual(["pointer", "type"])
  })

  it("stops before later effects after a failed pixel or semantic postcondition", async () => {
    const calls: string[] = []
    const result = await executeSequence(
      input([
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Tab" },
          postconditions: [{ kind: "control", controlID: "editor", focused: true }],
          recovery: "stop",
        },
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ]),
      {
        step: async (action) => {
          calls.push(action.key ?? action.operation)
          return scene(2, "first", false)
        },
        cancelled: () => false,
        now: () => 100,
      },
    )

    expect(result).toMatchObject({ status: "stopped", completed: 1 })
    expect(result.reason).toMatch(/focused=true/i)
    expect(calls).toEqual(["Tab"])
  })

  it("checks semantic preconditions before dispatching a step", async () => {
    const calls: string[] = []
    const result = await executeSequence(
      input([
        {
          action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
          preconditions: [{ kind: "control", controlID: "editor", focused: true }],
          postconditions: [{ kind: "pixels", change: "changed" }],
          recovery: "stop",
        },
      ]),
      {
        step: async (action) => {
          calls.push(action.operation)
          return scene(2, "next")
        },
        cancelled: () => false,
        now: () => 100,
      },
    )

    expect(result).toMatchObject({ status: "stopped", completed: 0, reason: expect.stringMatching(/precondition/i) })
    expect(calls).toEqual([])
  })

  it("stops on cancellation, duration, or an unexpected window without dispatch", async () => {
    const step = {
      action: { operation: "key" as const, windowID: "window-1", sensitive: false as const, key: "Enter" },
      postconditions: [{ kind: "pixels" as const, change: "changed" as const }],
      recovery: "stop" as const,
    }
    const dispatch = async () => {
      throw new Error("must not dispatch")
    }

    expect(
      await executeSequence(input([step]), { step: dispatch, cancelled: () => true, now: () => 100 }),
    ).toMatchObject({ status: "stopped", completed: 0, reason: expect.stringMatching(/cancelled/i) })
    expect(
      await executeSequence(
        { ...input([step]), maxDurationMs: 100 },
        {
          step: dispatch,
          cancelled: () => false,
          now: (() => {
            let time = 0
            return () => (time += 100)
          })(),
        },
      ),
    ).toMatchObject({ status: "stopped", completed: 0, reason: expect.stringMatching(/maximum duration/i) })
    expect(
      await executeSequence(input([{ ...step, action: { ...step.action, windowID: "window-2" } }]), {
        step: dispatch,
        cancelled: () => false,
        now: () => 100,
      }),
    ).toMatchObject({ status: "stopped", completed: 0, reason: expect.stringMatching(/target window changed/i) })
  })

  it("stops after an effect when cancellation or the duration limit occurs during dispatch", async () => {
    const step = {
      action: { operation: "key" as const, windowID: "window-1", sensitive: false as const, key: "Enter" },
      postconditions: [{ kind: "pixels" as const, change: "changed" as const }],
      recovery: "stop" as const,
    }
    let cancelled = false
    const cancelledResult = await executeSequence(input([step, step]), {
      step: async () => {
        cancelled = true
        return scene(2, "next")
      },
      cancelled: () => cancelled,
      now: () => 100,
    })
    expect(cancelledResult).toMatchObject({
      status: "stopped",
      completed: 1,
      reason: expect.stringMatching(/cancelled/i),
    })

    const times = [0, 0, 100]
    const durationResult = await executeSequence(
      { ...input([step, step]), maxDurationMs: 100 },
      {
        step: async () => scene(2, "next"),
        cancelled: () => false,
        now: () => times.shift() ?? 100,
      },
    )
    expect(durationResult).toMatchObject({
      status: "stopped",
      completed: 1,
      reason: expect.stringMatching(/maximum duration/i),
    })
  })

  it("rejects unbounded plans and unsupported recovery before dispatch", async () => {
    const runner = { step: async () => scene(2, "next"), cancelled: () => false, now: () => 0 }
    await expect(executeSequence({ ...input([]), maxDurationMs: 99 }, runner)).rejects.toThrow(/duration/i)
    await expect(executeSequence(input([]), runner)).rejects.toThrow(/1 through 8/i)
    await expect(
      executeSequence(
        input([
          {
            action: { operation: "key", windowID: "window-1", sensitive: false, key: "Enter" },
            postconditions: [],
            recovery: "stop",
          },
        ]),
        runner,
      ),
    ).rejects.toThrow(/postconditions/i)
  })
})
