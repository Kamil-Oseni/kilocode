import { expect, test } from "bun:test"
import path from "node:path"

test("routine worker options retain focus through replacement refreshes and use live actions", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-options-refresh-view.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
