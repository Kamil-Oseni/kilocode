import { expect, test } from "bun:test"
import path from "node:path"

test("schedule policy controls preserve unset legacy choices until explicit selection", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-policy.mjs"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 30_000)
