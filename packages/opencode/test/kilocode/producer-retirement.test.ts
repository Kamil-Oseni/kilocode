import { expect, test } from "bun:test"
import path from "node:path"

test("production producer retirement fences external work and joins accepted Git and actual finalizers", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/producer-retirement.ts")],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill(), 25_000)
  try {
    const code = await child.exited
    const [stdout, stderr] = await output
    expect(code, stdout + stderr).toBe(0)
    expect(stdout).toContain("producer-retirement actual Git and finalizers passed")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    await output
  }
}, 30_000)
