import { describe, expect, it } from "bun:test"
import { DesktopSemanticWorker } from "../../src/services/computer-use/desktop-semantic-worker"
import { runner } from "../../src/services/computer-use/desktop-windows"

describe("independent desktop semantic worker", () => {
  it("cancels a real blocked child without cancelling input and restarts for a fresh read", async () => {
    const input = runner()
    const source = runner()
    const worker = new DesktopSemanticWorker(source)
    try {
      await source.run("'warm'")
      expect((await worker.read("'ready'")).trim()).toBe("ready")
      expect((await input.run("'input-ready'")).trim()).toBe("input-ready")
      const pending = worker.read("Start-Sleep -Seconds 10; 'retired'")
      const outcome = pending.catch((error: unknown) => error)
      await Bun.sleep(30)
      await expect(worker.read("'overlap'")).rejects.toThrow(/already active/)
      expect((await input.run("'independent'")).trim()).toBe("independent")
      worker.cancel()
      expect(await outcome).toBeInstanceOf(Error)
      expect(((await outcome) as Error).message).toMatch(/cancelled/)
      await source.run("'replacement'")
      expect((await worker.read("'fresh'")).trim()).toBe("fresh")
    } finally {
      worker.cancel()
      input.cancel()
    }
  }, 30_000)

  it("kills a real provider timeout and never admits the expired reply", async () => {
    const source = runner()
    const worker = new DesktopSemanticWorker(source, 150)
    try {
      await source.run("'warm'")
      await expect(worker.read("Start-Sleep -Seconds 10; 'expired'")).rejects.toThrow(/timed out/)
      // Warm the replacement independently so this test measures the read deadline rather than process startup.
      await source.run("'replacement'")
      expect((await worker.read("'new-generation'")).trim()).toBe("new-generation")
    } finally {
      worker.cancel()
    }
  }, 30_000)

  it("cancels before a queued read can start its child", async () => {
    const source = runner()
    const worker = new DesktopSemanticWorker(source)
    const pending = worker.read("throw 'must not run'")
    const outcome = pending.catch((error: unknown) => error)
    worker.cancel()
    expect(((await outcome) as Error).message).toMatch(/cancelled/)
    try {
      await source.run("'warm'")
      expect((await worker.read("'after-cancel'")).trim()).toBe("after-cancel")
    } finally {
      worker.cancel()
    }
  }, 30_000)

  it("refuses invalid or expanded deadlines", () => {
    const source = runner()
    for (const timeout of [0, -1, 15_001, Infinity, 1.5]) {
      expect(() => new DesktopSemanticWorker(source, timeout)).toThrow(/deadline is invalid/)
    }
  })

  it("never starts its real runner when the deadline expires before the first microtask", async () => {
    const source = runner()
    let calls = 0
    const worker = new DesktopSemanticWorker(
      {
        run: (script) => {
          calls += 1
          return source.run(script)
        },
        cancel: () => source.cancel(),
      },
      10,
    )
    const outcome = worker.read("'must-not-start'").catch((error: unknown) => error)
    const until = performance.now() + 30
    while (performance.now() < until) continue
    expect(((await outcome) as Error).message).toMatch(/timed out/)
    expect(calls).toBe(0)
    worker.cancel()
  })
})
