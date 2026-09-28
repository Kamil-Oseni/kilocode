import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

const execute = promisify(execFile)
const binary = process.env.RAYA_DESKTOP_NAMES_BINARY
const suite = process.platform === "win32" && binary ? describe : describe.skip

suite("native desktop metadata only", () => {
  test("reads exact bounded desktop identity without entering the input broker", async () => {
    const output = await execute(binary!, ["--desktop-names-v1"], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    })
    const value = JSON.parse(output.stdout)
    expect(Object.keys(value).sort()).toEqual(["host", "input", "interactive", "operation", "version"])
    expect(value.version).toBe(1)
    expect(value.operation).toBe("desktop-names")
    expect(value.host === null || (typeof value.host === "string" && value.host.length > 0)).toBe(true)
    expect(value.input === null || (typeof value.input === "string" && value.input.length > 0)).toBe(true)
    expect(value.interactive).toBe(value.host === "Default" && value.input === "Default")
    expect(output.stderr).toBe("")
    expect(Buffer.byteLength(output.stdout)).toBeLessThan(4096)
  })

  test("checks Unicode and quote names on a disposable never-switched desktop", async () => {
    const output = await execute(binary!, ["--desktop-names-self-test-v1"], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    })
    expect(output.stdout).toBe("")
    expect(output.stderr).toBe("")
  })

  test.each([["--desktop-names-v2"], ["--desktop-names-v1", "extra"]])(
    "refuses invalid metadata arguments %j before broker initialization",
    async (...args) => {
      const result = await execute(binary!, args, { windowsHide: true, timeout: 5000, maxBuffer: 4096 }).then(
        () => ({ code: 0, stdout: "unexpected", stderr: "unexpected" }),
        (err: Error & { code?: number; stdout?: string; stderr?: string }) => err,
      )
      expect(result.code).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("")
    },
  )

  test("records child acquisition timings independently of capture and model calls", async () => {
    const times: number[] = []
    for (let index = 0; index < 6; index++) {
      const start = performance.now()
      await execute(binary!, ["--desktop-names-v1"], { windowsHide: true, timeout: 5000, maxBuffer: 4096 })
      times.push(performance.now() - start)
    }
    const warm = times.slice(1).sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        operation: "desktop-names",
        firstMs: times[0],
        warmP50Ms: warm[2],
        warmMaxMs: warm[4],
        samples: times.length,
        sha256: createHash("sha256")
          .update(await readFile(binary!))
          .digest("hex"),
      }),
    )
    expect(times).toHaveLength(6)
    expect(times.every((value) => Number.isFinite(value) && value > 0)).toBe(true)
  })
})
