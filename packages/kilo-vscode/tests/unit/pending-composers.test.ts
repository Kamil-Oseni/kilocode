import { expect, it } from "bun:test"
import { join } from "node:path"

it("preserves pending composer ownership under the browser reactive runtime", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "test", join(import.meta.dir, "../fixtures/pending-composers.test.ts")],
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
  expect(stderr).toContain("1 pass")
  expect(stderr).toContain("0 fail")
}, 30_000)
