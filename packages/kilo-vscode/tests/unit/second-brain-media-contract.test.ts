import { expect, test } from "bun:test"
import path from "node:path"
import { exec } from "../../src/util/process"

const native = process.platform === "win32" ? test : test.skip

native(
  "actual stdlib media audit and PCM contracts preserve source authority without model imports",
  async () => {
    const result = await exec(
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      ["-I", "-S", "-B", path.resolve(import.meta.dir, "../fixtures/media_contract.py")],
      { maxBuffer: 65536 },
    )
    expect(result.stderr).toContain("Ran 8 tests")
    expect(result.stderr).toContain("OK")
    expect(result.stdout).toBe("")
  },
  30_000,
)
