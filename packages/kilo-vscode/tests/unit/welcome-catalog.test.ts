import { expect, test } from "bun:test"
import path from "node:path"

test("the actual welcome catalog requests history on connection and backend reconnect", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/welcome-catalog.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
