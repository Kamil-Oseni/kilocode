import { expect, test } from "bun:test"
import path from "node:path"

test("organization editor keeps worker edits and archive action reachable", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-organization-editor.mjs"], {
    cwd: root,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
