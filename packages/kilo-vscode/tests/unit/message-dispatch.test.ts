import { expect, it } from "bun:test"
import path from "node:path"

it("publishes coherent session promotions in the browser runtime and preserves dispatch semantics", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/message-dispatch.ts")],
    {
      cwd: path.join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    passed: true,
    orders: 2,
    exceptionsRetained: true,
    setIterationRetained: true,
    asynchronousBoundaryRetained: true,
  })
})
