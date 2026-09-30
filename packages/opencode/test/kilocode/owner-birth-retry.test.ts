import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/owner-birth-retry.ts", import.meta.url))

test.skipIf(process.platform !== "win32")(
  "failed first native birth probe recovers without weakening owner checks",
  async () => {
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000)
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, error }).toEqual({ code: 0, error: "" })
      expect(output.trim().endsWith("birth retry passed")).toBe(true)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  },
  50_000,
)
