import { expect, test } from "bun:test"
import { join } from "node:path"

test("voice provider binds setup failures and cleanup feedback to the active connection", async () => {
  const child = Bun.spawn(["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/realtime-provider.mjs")], {
    cwd: join(import.meta.dir, "../.."),
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
}, 30_000)
