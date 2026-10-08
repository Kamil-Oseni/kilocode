import { expect, test } from "bun:test"
import path from "node:path"

test("personal capture preserves notes, journal evidence, cancellation and conflicts", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      path.join(process.cwd(), "tests/fixtures/memory_capture.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toContain("Ran 14 tests")
  expect(error).toContain("OK")
}, 30_000)
