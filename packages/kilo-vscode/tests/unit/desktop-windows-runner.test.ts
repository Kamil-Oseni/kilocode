import { describe, expect, it } from "bun:test"
import { runner } from "../../src/services/computer-use/desktop-windows"

describe.skipIf(process.platform !== "win32")("persistent Windows desktop runner", () => {
  it("reuses one host and recovers after cancellation", async () => {
    const host = runner()
    const first = await host.run("[string]$PID")
    const second = await host.run("[string]$PID")
    expect(second).toBe(first)

    const pending = host.run("Start-Sleep -Seconds 30; 'late'")
    host.cancel()
    await expect(pending).rejects.toThrow(/cancelled/i)

    expect(await host.run("'ready'")).toBe("ready")
    host.cancel()
  })

  it("returns bounded command errors without terminating the host", async () => {
    const host = runner()
    await expect(host.run("throw 'expected failure'")).rejects.toThrow("expected failure")
    expect(await host.run("'still ready'")).toBe("still ready")
    host.cancel()
  })

  it(
    "terminates an oversized response and starts a fresh bounded host",
    async () => {
      const host = runner()
      await expect(host.run("[string]::new('a', 24 * 1024 * 1024)")).rejects.toThrow(/bounded output limit/i)
      expect(await host.run("'recovered'")).toBe("recovered")
      host.cancel()
    },
    15_000,
  )
})
