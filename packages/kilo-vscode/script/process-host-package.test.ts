import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createVSIX } from "@vscode/vsce"
import { openPromise } from "yauzl"
import { ProcessHost } from "../../opencode/script/kilocode/process-host"

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "packages validated native process assets and capability declaration beside the CLI in an actual VSIX",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-process-vsix-"))
    try {
      const source = path.join(root, "source")
      const extension = path.join(root, "extension")
      const bin = path.join(extension, "bin")
      await ProcessHost.build(source, "x64")
      await mkdir(bin, { recursive: true })
      await ProcessHost.stage(source, bin, "x64")
      await writeFile(path.join(bin, "kilo.exe"), "CLI package entry fixture")
      await writeFile(path.join(extension, "extension.js"), "exports.activate = () => {}")
      await writeFile(
        path.join(extension, "package.json"),
        JSON.stringify({
          name: "raya-process-fixture",
          publisher: "raya-test",
          version: "1.0.0",
          engines: { vscode: "^1.105.0" },
          main: "extension.js",
          activationEvents: ["onStartupFinished"],
          description: "Native process packaging fixture",
          license: "MIT",
        }),
      )
      const ignore = await readFile(path.resolve(import.meta.dirname, "../.vscodeignore"), "utf8")
      await writeFile(path.join(extension, ".vscodeignore"), ProcessHost.include(ignore))
      const output = path.join(root, "native.vsix")
      await createVSIX({
        cwd: extension,
        packagePath: output,
        target: "win32-x64",
        dependencies: false,
        skipLicense: true,
        allowMissingRepository: true,
      })
      const zip = await openPromise(output, { strictFileNames: true, autoClose: false })
      try {
        const expected = new Set(
          [...ProcessHost.files, "raya-process-mode.json"].map((file) => `extension/bin/${file}`),
        )
        for await (const entry of zip.eachEntry()) {
          if (!expected.delete(entry.fileName)) continue
          expect(entry.uncompressedSize).toBeLessThan(64 * 1024 * 1024)
          const stream = await zip.openReadStreamPromise(entry)
          const parts: Buffer[] = []
          for await (const chunk of stream) parts.push(Buffer.from(chunk))
          expect(Buffer.concat(parts)).toEqual(await readFile(path.join(bin, path.basename(entry.fileName))))
        }
        expect(expected.size).toBe(0)
      } finally {
        zip.close()
      }
      expect(() => ProcessHost.include("bin/raya-process-host.exe\n")).toThrow("exclusions")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  180000,
)
