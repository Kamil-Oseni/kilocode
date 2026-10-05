import { expect, test } from "bun:test"
import path from "node:path"

test("composer distinguishes catalog loading and failure from a missing model without resetting its draft or selection", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/composer-provider-recovery.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
