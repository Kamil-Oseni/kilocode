import { expect, test } from "bun:test"
import path from "node:path"

test("existing-routine editing preserves confirmation and acknowledgement identity in the actual view", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-edit-view.mjs"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
