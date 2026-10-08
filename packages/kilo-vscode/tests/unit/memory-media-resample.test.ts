import { expect, test } from "bun:test"
import path from "node:path"

test("video audio resampling retains final samples within the selected span", async () => {
  const root = process.cwd()
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Retrieval/Candidates/GemmaMedia-20261008-root/venv/Scripts/python.exe",
      "-I",
      "-B",
      path.join(root, "tests/fixtures/memory_media_resample.py"),
      path.join(root, "script/memory/media"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(output).toContain("Four exact video audio spans preserved.")
}, 30_000)
