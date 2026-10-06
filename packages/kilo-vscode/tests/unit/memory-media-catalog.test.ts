import { expect, test } from "bun:test"
import path from "node:path"

test("media catalog preserves snapshots, validates model space and retires forgotten evidence", async () => {
  const root = process.cwd()
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      path.join(root, "tests/fixtures/memory_media_catalog.py"),
      path.join(root, "script/memory/media/library.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toContain("Ran 9 tests")
  expect(error).toContain("OK")
}, 30_000)
