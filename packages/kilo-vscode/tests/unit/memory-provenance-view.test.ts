import { expect, test } from "bun:test"
import { join } from "node:path"

test("persisted memory receipts render once in actual transcript chunks without content or unsafe actions", async () => {
  const child = Bun.spawn(
    ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/memory-provenance-view.mjs")],
    {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
}, 60_000)
