import { describe, expect, it } from "bun:test"
import { WindowsDesktopDriver, runner } from "../../src/services/computer-use/desktop-windows"

describe.skipIf(process.platform !== "win32")("persistent Windows desktop runner", () => {
  it("warms the host without desktop observation or input", async () => {
    const host = runner()
    const driver = new WindowsDesktopDriver(host)
    try {
      await driver.warmup()
      const first = await host.run("[string]$PID")
      await driver.warmup()
      expect(await host.run("[string]$PID")).toBe(first)
    } finally {
      driver.cancel()
    }
  }, 30_000)

  it("keeps selected-window probes off a busy single-command desktop runner", async () => {
    const host = runner()
    const scripts: string[] = []
    const probe = {
      run: async (script: string) => {
        scripts.push(script)
        return JSON.stringify({ windowID: "0x123", location: "test", title: "Editor", identity: "A".repeat(64) })
      },
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(host, undefined, undefined, [], undefined, probe)
    try {
      await driver.warmup()
      const pending = host.run("Start-Sleep -Milliseconds 500; 'done'")
      await expect(host.run("'overlap'")).rejects.toThrow(/already active/i)
      expect(await driver.probeCurrent()).toEqual({ windowID: "0x123" })
      expect(await driver.probePinCurrent("0x123")).toEqual({ windowID: "0x123", identity: "A".repeat(64) })
      expect(scripts).toHaveLength(2)
      expect(await pending).toBe("done")
    } finally {
      driver.cancel()
    }
  }, 30_000)

  it("releases only unmatched native input in an accepted SendInput prefix", async () => {
    let script = ""
    const driver = new WindowsDesktopDriver({
      run: async (value) => {
        script = value
        return ""
      },
      cancel: () => undefined,
    })
    await driver.perform(
      { windowID: "0x1", observationID: "test", sensitive: false, operation: "key", key: "A" },
      { windowID: "0x1", location: "test" },
    )
    const source = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1]
    expect(source).toBeTruthy()
    const host = runner()
    const probe = String.raw`
public static class RayaInputProbe {
  private static RayaDesktopNative.Input Mouse(uint flags) {
    return new RayaDesktopNative.Input {
      Type = 0,
      Value = new RayaDesktopNative.InputUnion {
        Mouse = new RayaDesktopNative.MouseInput { Flags = flags }
      }
    };
  }
  private static RayaDesktopNative.Input Key(ushort key, bool up) {
    return new RayaDesktopNative.Input {
      Type = 1,
      Value = new RayaDesktopNative.InputUnion {
        Keyboard = new RayaDesktopNative.KeyboardInput { VirtualKey = key, Flags = up ? 2u : 0u }
      }
    };
  }
  public static string Run() {
    var mouse = new[] { Mouse(0xC001), Mouse(2), Mouse(4), Mouse(2), Mouse(4) };
    var keys = new[] { Key(0x11, false), Key(0x41, false), Key(0x41, true), Key(0x11, true) };
    return String.Join(",", new[] {
      RayaDesktopNative.UnmatchedMouseDown(mouse, 0, 2, 4).ToString(),
      RayaDesktopNative.UnmatchedMouseDown(mouse, 2, 2, 4).ToString(),
      RayaDesktopNative.UnmatchedMouseDown(mouse, 3, 2, 4).ToString(),
      RayaDesktopNative.UnmatchedMouseDown(mouse, 4, 2, 4).ToString(),
      RayaDesktopNative.HeldKeys(keys, 0).Length.ToString(),
      String.Join(":", RayaDesktopNative.HeldKeys(keys, 2)),
      String.Join(":", RayaDesktopNative.HeldKeys(keys, 3)),
      RayaDesktopNative.HeldKeys(keys, 4).Length.ToString()
    });
  }
}
`
    try {
      expect(await host.run(`Add-Type -TypeDefinition @'\n${source}\n${probe}\n'@\n[RayaInputProbe]::Run()`)).toBe(
        "False,True,False,True,0,65:17,17,0",
      )
    } finally {
      host.cancel()
    }
  })

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

  it("terminates an oversized response and starts a fresh bounded host", async () => {
    const host = runner()
    await expect(host.run("[string]::new('a', 24 * 1024 * 1024)")).rejects.toThrow(/bounded output limit/i)
    expect(await host.run("'recovered'")).toBe("recovered")
    host.cancel()
  }, 15_000)
})

describe("Windows desktop host preparation", () => {
  it("coalesces startup and retries after cancellation without dispatching input", async () => {
    const scripts: string[] = []
    let reject: ((error: Error) => void) | undefined
    let calls = 0
    const driver = new WindowsDesktopDriver({
      run: (script) => {
        scripts.push(script)
        calls++
        if (calls > 1) return Promise.resolve("")
        return new Promise<string>((_resolve, fail) => {
          reject = fail
        })
      },
      cancel: () => reject?.(new Error("Windows desktop driver command was cancelled")),
    })
    const first = driver.warmup()
    const second = driver.warmup()
    expect(scripts).toEqual(["$null"])
    const settled = Promise.allSettled([first, second])
    driver.cancel()
    expect(await settled).toMatchObject([
      { status: "rejected", reason: { message: "Windows desktop driver command was cancelled" } },
      { status: "rejected", reason: { message: "Windows desktop driver command was cancelled" } },
    ])
    await driver.warmup()
    expect(scripts).toEqual(["$null", "$null"])
    driver.cancel()
  })

  it("rejects malformed readiness and retries with a new no-input probe", async () => {
    const scripts: string[] = []
    const outputs = ["unexpected", ""]
    const driver = new WindowsDesktopDriver({
      run: async (script) => {
        scripts.push(script)
        return outputs.shift() ?? ""
      },
      cancel: () => undefined,
    })
    await expect(driver.warmup()).rejects.toThrow(/readiness response is invalid/)
    await driver.warmup()
    expect(scripts).toEqual(["$null", "$null"])
    driver.cancel()
  })
})
