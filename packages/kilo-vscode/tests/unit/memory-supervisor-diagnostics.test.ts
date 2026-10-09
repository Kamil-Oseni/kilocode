import { expect, test } from "bun:test"
import path from "node:path"
import { exec } from "../../src/util/process"
import { current, supervisors } from "../../src/second-brain/managed/catalog"
import { release } from "../../src/second-brain/control/catalog-capture"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { sha } from "../../src/second-brain/control/frames"
import { readFile } from "node:fs/promises"

const native = process.platform === "win32" ? test : test.skip

native(
  "supervisor resource observations retain every cold admission floor without changing actual gates",
  async () => {
    const result = await exec(
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      ["-I", "-S", "-B", path.resolve(import.meta.dir, "../fixtures/memory_supervisor_settlement.py")],
      { maxBuffer: 65536 },
    )
    expect(result.stderr).toContain("Ran 7 tests")
    expect(result.stderr).toContain("OK")
    expect(result.stdout).toBe("")
  },
  30_000,
)

test("diagnostic supervisor pin matches its image and retains the previous immutable cohort", async () => {
  const raw = await readFile(path.resolve(import.meta.dir, "../../script/memory/supervise.py"))
  expect(sha(raw)).toBe(current)
  expect(supervisors).toContain("7c2286962a606fade513e4742369d0f084609549961650347b89f44f1f266bcd")
  expect(fingerprint(release)).toBe("5925615e1b3ce64155a01fad2f1cb02fba7ee6d808901e80f312678b8f68c747")
})
