import { expect, test } from "bun:test"
import { join } from "node:path"

test("OpenAI VoiceProvider correlates admission, settings changes and late bridge events", async () => {
  const child = Bun.spawn(["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/openai-provider.mjs")], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const timer = setTimeout(() => child.kill(), 25_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("OpenAI provider integration passed: 41 assertions")
}, 30_000)
