import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud history rejects stale responses, retries scoped failures and preserves active rows", async () => {
  const child = Bun.spawn(
    ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/cloud-history-view.mjs")],
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
