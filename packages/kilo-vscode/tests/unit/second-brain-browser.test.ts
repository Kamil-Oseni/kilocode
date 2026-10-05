import { expect, test } from "bun:test"
import { join } from "node:path"

test("SecondBrain real DOM handshake uses the actual host coordinator and loopback without chat attachment", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", join(import.meta.dir, "../fixtures/second-brain-browser.mjs")],
    { cwd: join(import.meta.dir, "../.."), windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("handshake and cancellation passed")
}, 20_000)
