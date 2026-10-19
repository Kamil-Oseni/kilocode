import { expect, test } from "bun:test"
import path from "node:path"

test("renders model claims, saved executable checks and legacy verification bases distinctly", async () => {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "tests/fixtures/routine-verification.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
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
