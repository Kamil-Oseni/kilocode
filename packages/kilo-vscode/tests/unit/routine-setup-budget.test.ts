import { expect, test } from "bun:test"
import path from "node:path"

test("conversational routine setup reviews an optional per-run cost limit", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-setup-budget.mjs"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 30_000)
