import { expect, test } from "bun:test"
import { join } from "node:path"

test("saved speech settings survive a lost read and block premature voice", async () => {
  for (const mode of ["success", "missing", "unmount"]) {
    const child = Bun.spawn(
      ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/speech-settings-handshake.mjs"), mode],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const timer = setTimeout(() => child.kill(), 15000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    expect(code, stdout + stderr).toBe(0)
    expect(stdout).toContain(`Speech settings handshake passed: ${mode}`)
  }
}, 50000)
