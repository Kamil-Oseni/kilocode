import { expect, test } from "bun:test"
import path from "node:path"

test("transferred profile view requires explicit current review and never starts workers", async () => {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "tests/fixtures/restore-review-view.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
}, 30000)
