import { expect, test } from "bun:test"
import path from "node:path"

test("renders durable routine cards and selects an existing reporting conversation", async () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawn([process.execPath, "--conditions=browser", "tests/fixtures/routine-activity.mjs"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, out + err).toBe(0)
}, 30_000)
