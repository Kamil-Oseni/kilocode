import { expect, test } from "bun:test"
import { join } from "node:path"

test("actual Speech settings show the default and key recovery without recording", async () => {
  const child = Bun.spawn(
    ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/speech-default-settings.mjs")],
    {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const timer = setTimeout(() => child.kill(), 25_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("Speech default settings integration passed: 15 assertions")
}, 30_000)
