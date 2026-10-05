import { test, expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const mode of ["maintenance", "lock", "competing", "safe", "failure", "rebind"]) {
  test(`actual CLI agent publication ${mode}`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/agent-publication.ts"), tmp.path, mode],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: "" })
    expect(JSON.parse(out).mode).toBe(mode)
    const receipt = await Bun.file(path.join(tmp.path, "receipt.json")).json()
    expect(receipt.terminal).toBe(true)
    expect(receipt.results.length).toBeGreaterThanOrEqual(2)
  }, 20000)
}
