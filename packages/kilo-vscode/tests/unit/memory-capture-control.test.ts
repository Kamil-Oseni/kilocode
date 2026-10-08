import { expect, test } from "bun:test"
import path from "node:path"
import { reply, type Op } from "../../src/second-brain/control/frames"

test("actual private capture bridge replies satisfy strict original-operation frames", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      path.join(process.cwd(), "tests/fixtures/memory_capture_control.py"),
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
  const rows = output.trim().split("\n")
  expect(rows.length).toBe(4)
  for (const line of rows) {
    const row = JSON.parse(line) as { root: string; op: Op; seq: number; raw: string; ok: boolean }
    const parse = () => reply(Buffer.from(row.raw), row.op, row.seq, row.root)
    if (row.ok) {
      expect(parse()).toBeDefined()
      continue
    }
    expect(parse).toThrow()
  }
}, 30_000)
