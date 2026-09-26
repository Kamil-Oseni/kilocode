import { describe, expect, it } from "bun:test"
import { DesktopCaptureWorker } from "../../src/services/computer-use/desktop-capture-worker"
import type { DesktopFrame } from "../../src/services/computer-use/desktop-session"

const frame = (windowID = "0x1", data = "pixels"): DesktopFrame => ({
  windowID,
  location: `pid:1;title:Editor;bounds:${windowID},0,100,100`,
  width: 100,
  height: 100,
  mime: "image/png",
  data,
  timing: { acquisitionMs: 1, preparationMs: 1, totalMs: 2 },
})

async function until(check: () => boolean) {
  for (let index = 0; index < 100 && !check(); index++) await Bun.sleep(2)
  expect(check()).toBe(true)
}

describe("continuous desktop capture worker", () => {
  it("holds one bounded latest scene and clears it immediately on stop", async () => {
    let count = 0
    let cancelled = 0
    const worker = new DesktopCaptureWorker(
      async () => frame("0x1", `pixels-${++count}`),
      () => cancelled++,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => !!worker.latest())
    expect(worker.latest()?.sequence).toBe(1)
    expect(worker.latest()?.frame.data).toBe("pixels-1")
    worker.stop()
    expect(worker.latest()).toBeUndefined()
    expect(cancelled).toBe(1)
    await Bun.sleep(60)
    expect(count).toBe(1)
  })

  it("discards a scoped scene when the foreground leaves scope and accepts its return", async () => {
    const frames = [frame("0x1", "first"), undefined, frame("0x1", "returned")]
    let count = 0
    const worker = new DesktopCaptureWorker(
      async () => frames[count++],
      () => undefined,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => worker.latest()?.frame.data === "first")
    for (let index = 0; index < 500 && count < 2; index++) await Bun.sleep(2)
    expect(count).toBeGreaterThanOrEqual(2)
    expect(worker.latest()).toBeUndefined()
    for (let index = 0; index < 500 && worker.latest()?.frame.data !== "returned"; index++) await Bun.sleep(2)
    expect(worker.latest()?.frame.data).toBe("returned")
    expect(worker.latest()?.version).toBe(2)
    worker.stop()
  })

  it("advances capture sequence for every sample but scene version only for changed pixels", async () => {
    const frames = [frame("0x1", "first"), frame("0x1", "first"), frame("0x1", "second")]
    let count = 0
    const worker = new DesktopCaptureWorker(
      async () => {
        const next = frames[count++]
        if (next) return next
        return new Promise<DesktopFrame>(() => undefined)
      },
      () => undefined,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => worker.latest()?.sequence === 1)
    expect(worker.latest()?.version).toBe(1)
    await until(() => worker.latest()?.sequence === 2)
    expect(worker.latest()?.version).toBe(1)
    await until(() => worker.latest()?.sequence === 3)
    expect(worker.latest()?.version).toBe(2)
    worker.stop()
  })

  it("renews a native scene only from its exact image base without copying pixels", async () => {
    let count = 0
    const visual = frame()
    const worker = new DesktopCaptureWorker(
      async () => {
        count++
        if (count === 1) return { ...visual, sourceSequence: 7 }
        return new Promise<DesktopFrame>(() => undefined)
      },
      () => undefined,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => worker.latest()?.sequence === 1)
    await Bun.sleep(140)
    expect(worker.latest()).toBeUndefined()
    expect(worker.renew(8, visual)).toBe(false)
    expect(worker.renew(7, { ...visual, location: "pid:1;title:Changed;bounds:0,0,100,100" })).toBe(false)
    expect(worker.renew(7, visual)).toBe(true)
    expect(worker.latest()?.sequence).toBe(2)
    expect(worker.latest()?.version).toBe(1)
    expect(worker.latest()?.frame.data).toBe("pixels")
    expect(count).toBeLessThanOrEqual(2)
    worker.stop()
    expect(worker.renew(7, visual)).toBe(false)
  })

  it("invalidates an old scene and drops a frame resolving after rebind", async () => {
    const pending: Array<(frame: DesktopFrame & { sourceSequence: number }) => void> = []
    const worker = new DesktopCaptureWorker(
      () => new Promise((resolve) => pending.push(resolve)),
      () => undefined,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => pending.length === 1)
    pending[0]!({ ...frame("0x1", "old"), sourceSequence: 1 })
    await until(() => worker.latest()?.frame.data === "old")
    await until(() => pending.length === 2)
    worker.invalidate()
    expect(worker.latest()).toBeUndefined()
    expect(worker.renew(1, frame("0x1", "old"))).toBe(false)
    pending[1]!({ ...frame("0x1", "late"), sourceSequence: 2 })
    await until(() => pending.length === 3)
    expect(worker.latest()).toBeUndefined()
    pending[2]!({ ...frame("0x2", "fresh"), sourceSequence: 3 })
    await until(() => worker.latest()?.frame.data === "fresh")
    expect(worker.latest()?.version).toBe(2)
    worker.stop()
  })

  it("discards a capture that resolves after Stop and accepts a new generation", async () => {
    const pending: Array<(frame: DesktopFrame) => void> = []
    const worker = new DesktopCaptureWorker(
      () => new Promise((resolve) => pending.push(resolve)),
      () => undefined,
      (error) => {
        throw error
      },
    )
    worker.start()
    await until(() => pending.length === 1)
    worker.stop()
    pending[0](frame("old"))
    await Bun.sleep(1)
    expect(worker.latest()).toBeUndefined()
    worker.start()
    await until(() => pending.length === 2)
    pending[1](frame("new"))
    await until(() => worker.latest()?.frame.windowID === "new")
    expect(worker.latest()?.sequence).toBe(1)
    worker.stop()
  })

  it("stops and reports malformed or oversized captures without retaining pixels", async () => {
    const errors: unknown[] = []
    let cancelled = 0
    const worker = new DesktopCaptureWorker(
      async () => ({ ...frame(), data: "x".repeat(20_000_001) }),
      () => cancelled++,
      (error) => errors.push(error),
    )
    worker.start()
    await until(() => errors.length === 1)
    expect(worker.latest()).toBeUndefined()
    expect(cancelled).toBe(1)
    expect(String(errors[0])).toContain("memory bounds")
  })

  it("treats capture failure as a stopped worker rather than retrying", async () => {
    const errors: unknown[] = []
    let count = 0
    const worker = new DesktopCaptureWorker(
      async () => {
        count++
        throw new Error("driver lost")
      },
      () => undefined,
      (error) => errors.push(error),
    )
    worker.start()
    await until(() => errors.length === 1)
    await Bun.sleep(60)
    expect(count).toBe(1)
    expect(worker.latest()).toBeUndefined()
  })
})
