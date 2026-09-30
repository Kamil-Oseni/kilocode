import { expect, test } from "bun:test"
import path from "node:path"

test("mounted Routine drafts retain pending edits through worker switches and stale SQL summaries", () => {
  const child = Bun.spawnSync(
    [process.execPath, "--conditions=browser", "tests/fixtures/routine-inbox-draft-recovery.mjs"],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 90_000)
