import { expect, test } from "bun:test"
import path from "node:path"

test("goal history renders retained audits, legacy fallback and scoped source requests", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/goal-history-view.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 60_000)
