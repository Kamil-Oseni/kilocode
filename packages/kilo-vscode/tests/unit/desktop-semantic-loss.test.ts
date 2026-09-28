import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { WindowsDesktopDriver } from "../../src/services/computer-use/desktop-windows"

const binary = process.env.RAYA_SEMANTIC_BINARY

test.skipIf(process.platform !== "win32" || !binary || !existsSync(binary))(
  "native semantic target refusal stops active observation before another action",
  async () => {
    const errors: unknown[] = []
    const source = {
      run: () => new Promise<string>(() => undefined),
      cancel: () => undefined,
    }
    const driver = new WindowsDesktopDriver(source, source, undefined, [], undefined, source, undefined, source, {
      binary: binary!,
    })
    driver.startCapture((error) => {
      errors.push(error)
      driver.stopCapture()
    })
    try {
      expect(Reflect.get(driver, "worker")).toBeDefined()
      await expect(
        driver.observeSemantics({
          windowID: "0xAB",
          identity: "A".repeat(64),
          location: "pid:7;title:Transport;bounds:0,0,400,300",
        }),
      ).rejects.toThrow(/target_changed/)
      expect(errors).toHaveLength(1)
      expect(Reflect.get(driver, "worker")).toBeUndefined()
      driver.cancel()
      expect(errors).toHaveLength(1)
    } finally {
      driver.cancel()
    }
  },
  5_000,
)
