import { test, expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const mode of ["workspace", "directory", "worktree", "failure", "alias", "rebind"]) {
  test(`actual agent builder ${mode} admission and retirement`, async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/agent-builder-lifetime.ts"), tmp.path, mode],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, error }).toEqual({ code: 0, error: "" })
    expect(JSON.parse(output).mode).toBe(mode)
    const receipt = await Bun.file(path.join(tmp.path, "receipt.json")).json()
    expect(receipt.terminal).toBe(true)
    expect(receipt.results.length).toBeGreaterThanOrEqual(2)
  }, 20000)
}
