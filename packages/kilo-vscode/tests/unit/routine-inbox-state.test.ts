import { expect, test } from "bun:test"
import path from "node:path"

test("routine inbox binds loading failure retry and filtered-empty states", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-inbox-state.mjs"], {
    cwd: root,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 30_000)
