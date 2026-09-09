import { expect, test } from "bun:test"
import { join } from "node:path"

test("goal audit distinguishes accepted references, requested verification, caveats, and user acceptance", async () => {
  const child = Bun.spawn(["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/goal-audit-view.mjs")], {
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
}, 60_000)
