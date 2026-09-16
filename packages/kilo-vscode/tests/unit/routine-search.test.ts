import { expect, test } from "bun:test"
import path from "node:path"

test("routine conversation search debounces, trims, resets, and clears", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-search.mjs"], {
    cwd: root,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 30_000)
