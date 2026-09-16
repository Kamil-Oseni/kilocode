import { describe, expect, it } from "vitest"
import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { once } from "node:events"
import { inspect, plan, platform, version } from "../../script/release-evidence"

const require = createRequire(import.meta.url)
const vsce = createRequire(require.resolve("@vscode/vsce"))
const { ZipFile } = vsce("yazl") as {
  ZipFile: new () => {
    outputStream: NodeJS.ReadableStream
    addBuffer(data: Buffer, name: string): void
    end(): void
  }
}

async function archive(file: string, extra?: string) {
  const zip = new ZipFile()
  const pkg = { name: "raya", publisher: "eden", version: "7.4.24" }
  const xml =
    '<?xml version="1.0"?><PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="7.4.24" TargetPlatform="win32-x64"/></Metadata></PackageManifest>'
  zip.addBuffer(Buffer.from(JSON.stringify(pkg)), "extension/package.json")
  zip.addBuffer(Buffer.from(xml), "extension.vsixmanifest")
  zip.addBuffer(Buffer.from("kilo"), "extension/bin/kilo.exe")
  if (extra) zip.addBuffer(Buffer.from("secret"), extra)
  const stream = createWriteStream(file)
  zip.outputStream.pipe(stream)
  zip.end()
  await once(stream, "close")
}

describe("release evidence runner", () => {
  it("normalizes release tags to the packaged version", () => {
    expect(version("raya-v7.4.24")).toBe("7.4.24")
    expect(version("v7.4.24-beta.1")).toBe("7.4.24")
    expect(version("7.4.24+build.3")).toBe("7.4.24")
    expect(() => version("main")).toThrow("x.y.z")
  })

  it("requires the native host for every declared target", () => {
    expect(platform("win32-x64", "win32", "x64").cli).toBe("extension/bin/kilo.exe")
    expect(platform("darwin-arm64", "darwin", "arm64").cli).toBe("extension/bin/kilo")
    expect(platform("linux-x64", "linux", "x64").cli).toBe("extension/bin/kilo")
    expect(() => platform("linux-x64", "win32", "x64")).toThrow("requires linux/x64")
    expect(() => platform("universal", "win32", "x64")).toThrow("Unsupported")
  })

  it("publishes the complete ordered source and migration gate plan", () => {
    expect(plan().map((item) => item.id)).toEqual([
      "support",
      "architecture",
      "workflows",
      "test-inventory",
      "generated-state",
      "effect-facades",
      "changesets",
      "migrations",
    ])
    expect(plan().find((item) => item.id === "migrations")?.cwd).toBe("packages/core")
  })

  it("inspects a real bounded VSIX and rejects sensitive entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-evidence-"))
    try {
      const valid = path.join(root, "raya-win32-x64.vsix")
      await archive(valid)
      const artifact = await inspect(valid, "win32-x64", "7.4.24")
      expect(artifact).toMatchObject({ entries: 3, cliBytes: 4, sensitiveEntries: 0 })
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)

      const unsafe = path.join(root, "unsafe.vsix")
      await archive(unsafe, "extension/.env")
      await expect(inspect(unsafe, "win32-x64", "7.4.24")).rejects.toThrow("environment, temporary")

      const cache = path.join(root, "cache.vsix")
      await archive(cache, "extension/.turbo/turbo-typecheck.log")
      await expect(inspect(cache, "win32-x64", "7.4.24")).rejects.toThrow("cache, or log")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
