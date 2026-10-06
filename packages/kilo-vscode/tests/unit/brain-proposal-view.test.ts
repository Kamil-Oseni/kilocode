import { expect, test } from "bun:test"
import path from "node:path"

test("real proposal view blocks uncertain writes and refreshes the original outcome", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "../fixtures/brain-proposal-view.mjs")],
    { cwd: path.join(import.meta.dir, "../.."), windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("proposal review outcome gate passed")
}, 20_000)
