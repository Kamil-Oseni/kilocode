import { expect, test } from "bun:test"
import { join } from "node:path"

test("voice recovery requires exact host acknowledgement and successful local cleanup", async () => {
  const child = Bun.spawn(["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/voice-recovery.mjs")], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("22 production-state assertions passed")
})
