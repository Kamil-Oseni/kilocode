import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listFiles, PackageManager } from "@vscode/vsce"

const root = join(import.meta.dir, "..", "..")
const dir = mkdtempSync(join(tmpdir(), "raya-capture-package-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("native capture is excluded by default and included only by the Windows build override", async () => {
  for (const path of ["bin", "native", "dist"]) mkdirSync(join(dir, path), { recursive: true })
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "raya", version: "1.0.0", publisher: "eden", engines: { vscode: "^1.106.0" } }),
  )
  writeFileSync(join(dir, "bin", "kilo.exe"), "cli")
  writeFileSync(join(dir, "bin", ".cli-version"), "local")
  writeFileSync(join(dir, "bin", "raya-desktop-capture.exe"), "candidate")
  writeFileSync(join(dir, "bin", "raya-desktop-capture.pdb"), "symbols")
  writeFileSync(join(dir, "native", "desktop-capture.cpp"), "source")
  writeFileSync(join(dir, "dist", "extension.js"), "extension")

  const source = await Bun.file(join(root, ".vscodeignore")).text()
  const rule = "bin/raya-desktop-capture.exe"
  const symbol = "bin/raya-desktop-capture.pdb"
  expect(source.split(/\r?\n/)).toContain(rule)
  expect(source.split(/\r?\n/)).toContain(symbol)
  const normal = join(dir, ".vscodeignore")
  const native = join(dir, "native.vscodeignore")
  writeFileSync(normal, source)
  writeFileSync(
    native,
    source
      .replace(/^bin\/raya-desktop-capture\.exe$/m, `!${rule}`)
      .replace(/^bin\/raya-desktop-capture\.pdb$/m, `!${symbol}`),
  )

  const files = await listFiles({ cwd: dir, packageManager: PackageManager.None, ignoreFile: normal })
  expect(files).toContain("bin/kilo.exe")
  expect(files).toContain("dist/extension.js")
  expect(files).not.toContain(rule)
  expect(files).not.toContain(symbol)
  expect(files).not.toContain("bin/.cli-version")
  expect(files).not.toContain("native/desktop-capture.cpp")

  const included = await listFiles({ cwd: dir, packageManager: PackageManager.None, ignoreFile: native })
  expect(included).toContain(rule)
  expect(included).toContain(symbol)
  expect(included).not.toContain("bin/.cli-version")
  expect(included).not.toContain("native/desktop-capture.cpp")
})
