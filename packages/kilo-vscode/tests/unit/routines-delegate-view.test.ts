import { expect, test } from "bun:test"
import path from "node:path"

test("routine conversation asks another worker and shows the tracked cards", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-delegate-view.mjs"], {
    cwd: root,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
