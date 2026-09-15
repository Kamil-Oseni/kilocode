// kilocode_change - new file
import { test, expect } from "bun:test"
import path from "path"

test("bin/kilo parses", async () => {
  const file = Bun.file(path.join(import.meta.dir, "..", "..", "bin", "kilo"))
  const code = (await file.text()).replace(/^#![^\n]*\n/, "")
  expect(() => new Function(code)).not.toThrow()
})

test("publishes Raya and legacy CLI commands through the same launcher", async () => {
  const root = path.join(import.meta.dir, "..", "..")
  const pkg: { bin?: Record<string, string> } = await Bun.file(path.join(root, "package.json")).json()
  expect(pkg.bin).toEqual({
    raya: "./bin/kilo",
    kilo: "./bin/kilo",
    kilocode: "./bin/kilo",
  })

  const publish = await Bun.file(path.join(root, "script", "publish.ts")).text()
  expect(publish).toContain("raya: `./bin/kilo`")
  expect(publish).toContain("kilo: `./bin/kilo`")
  expect(publish).toContain("kilocode: `./bin/kilo`")
})
