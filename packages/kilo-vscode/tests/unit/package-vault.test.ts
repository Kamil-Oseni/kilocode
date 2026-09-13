import { createWriteStream } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { expect, test } from "bun:test"
import { PackageVault } from "../../src/services/package-vault"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}

async function fixture() {
  const root = await mkdtemp(join(import.meta.dir, ".package-vault-"))
  const source = join(root, "source.vsix")
  const binary = Buffer.from("retained kilo binary")
  const target = `${process.platform}-${process.arch}`
  const zip = new writer.ZipFile()
  zip.addBuffer(
    Buffer.from(JSON.stringify({ name: "raya", publisher: "eden", version: "1.2.3" })),
    "extension/package.json",
  )
  zip.addBuffer(
    Buffer.from(
      `<PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="1.2.3" TargetPlatform="${target}" /></Metadata></PackageManifest>`,
    ),
    "extension.vsixmanifest",
  )
  zip.addBuffer(binary, `extension/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`)
  const done = pipeline(zip.outputStream, createWriteStream(source))
  zip.end()
  await done
  return { root, source, binary, target }
}

test("retains and revalidates one exact active package across service restart", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "vault")
    const vault = new PackageVault(root)
    const saved = await vault.retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: "1.2.3",
      target: run.target,
    })
    expect(saved.package).toStartWith(root)
    expect(saved.artifact.size).toBeGreaterThan(0)
    expect(saved.binary.size).toBe(run.binary.length)
    expect(await vault.current()).toBeUndefined()
    const binary = join(run.root, "kilo.exe")
    await writeFile(binary, run.binary)
    expect(await vault.activate("1.2.3", run.target, binary)).toEqual(saved)
    await rm(run.source)
    expect(await new PackageVault(root).current()).toEqual(saved)
    expect(await new PackageVault(root).activate("1.2.3", run.target, binary)).toEqual(saved)
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("rejects changed package bytes and retains an invalid index", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "vault")
    const vault = new PackageVault(root)
    const saved = await vault.retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: "1.2.3",
      target: run.target,
    })
    const binary = join(run.root, "kilo.exe")
    await writeFile(binary, run.binary)
    await writeFile(saved.package, "changed")
    await expect(vault.activate("1.2.3", run.target, binary)).rejects.toThrow()
    await writeFile(join(root, "packages.json"), '{"malformed":true}')
    await expect(new PackageVault(root).current()).rejects.toThrow("invalid and was retained")
    expect(await readFile(join(root, "packages.json"), "utf8")).toBe('{"malformed":true}')
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})
