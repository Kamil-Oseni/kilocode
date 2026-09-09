import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { verify } from "../../src/services/update-vsix"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}
const expected = { name: "raya", publisher: "eden", version: "1.2.3", target: "win32-x64" }

test.each(["valid", "publisher", "version", "target", "missing", "duplicate", "oversized", "doctype"])(
  "validates %s VSIX manifests before installation",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "raya-vsix-"))
    try {
      const zip = new writer.ZipFile()
      const pkg = {
        ...expected,
        publisher: mode === "publisher" ? "other" : expected.publisher,
        version: mode === "version" ? "9.9.9" : expected.version,
      }
      const json = mode === "oversized" ? " ".repeat(2 * 1024 * 1024 + 1) : JSON.stringify(pkg)
      zip.addBuffer(Buffer.from(json), "extension/package.json")
      if (mode === "duplicate") zip.addBuffer(Buffer.from(json), "extension/package.json")
      if (mode !== "missing")
        zip.addBuffer(
          Buffer.from(
            `${mode === "doctype" ? '<!DOCTYPE PackageManifest [<!ENTITY custom "unsafe">]>' : ""}<PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="1.2.3" TargetPlatform="${mode === "target" ? "darwin-arm64" : expected.target}" /></Metadata></PackageManifest>`,
          ),
          "extension.vsixmanifest",
        )
      const path = join(root, "test.vsix")
      const done = pipeline(zip.outputStream, createWriteStream(path))
      zip.end()
      await done
      if (mode === "valid") await verify(path, expected)
      if (mode !== "valid") await expect(verify(path, expected)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
