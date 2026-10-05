import { test, expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const mode of [
  "cycle",
  "purged-reader",
  "stale",
  "failure",
  "alias",
  "rebind",
  "heartbeat",
  "queue-tamper",
  "namespace",
  "global",
  "file",
  "recovery",
  "show-recovery",
  "prune",
  "purge",
  "concurrent",
  "slots",
  "saturation",
  "bounded",
  "retire",
]) {
  test(`actual memory writer ${mode} admission and lifetime`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/memory-writer-admission.ts"), tmp.path, mode],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => child.kill(), 15000)
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    expect({ code, error: err }).toEqual({ code: 0, error: "" })
    const receipt = JSON.parse(out.trim().split(/\r?\n/).at(-1)!)
    expect(receipt.mode).toBe(mode)
    expect(receipt.passed).toBe(true)
    expect(receipt.results.length).toBeGreaterThan(1)
  }, 20000)
}
