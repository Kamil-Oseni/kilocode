import { expect, test } from "bun:test"
import path from "node:path"

test("goal steering retains its draft and revision until a matching acknowledgement", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/goal-edit-view.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 60_000)
