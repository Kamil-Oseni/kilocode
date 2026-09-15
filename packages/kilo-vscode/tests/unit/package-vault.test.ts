import { createWriteStream } from "node:fs"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import { expect, test } from "bun:test"
import { PackageVault, type Package } from "../../src/services/package-vault"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}

async function archive(root: string, version: string, text: string, name: string) {
  const source = join(root, name)
  const binary = Buffer.from(text)
  const target = `${process.platform}-${process.arch}`
  const zip = new writer.ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify({ name: "raya", publisher: "eden", version })), "extension/package.json")
  zip.addBuffer(
    Buffer.from(
      `<PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="${version}" TargetPlatform="${target}" /></Metadata></PackageManifest>`,
    ),
    "extension.vsixmanifest",
  )
  zip.addBuffer(binary, `extension/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`)
  const done = pipeline(zip.outputStream, createWriteStream(source))
  zip.end()
  await done
  return { source, binary, target, version }
}

async function fixture() {
  const root = await mkdtemp(join(import.meta.dir, ".package-vault-"))
  return { root, ...(await archive(root, "1.2.3", "retained kilo binary", "source.vsix")) }
}

function gate(target: "retain" | "activate") {
  const entered = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: () => resumed.resolve(),
    barrier: async (phase: "retain" | "activate") => {
      if (phase !== target) return
      entered.resolve()
      await resumed.promise
    },
  }
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

test("prunes stale snapshots while preserving active, current, recent and release packages", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "vault")
    await mkdir(root)
    const packages = [
      { version: "7.4.23-snapshot+old", digest: "1".repeat(64), retainedAt: 1 },
      { version: "7.4.23-snapshot+active", digest: "2".repeat(64), retainedAt: 2 },
      { version: "7.4.23-snapshot+recent", digest: "3".repeat(64), retainedAt: 3 },
      { version: "7.4.23-snapshot+current", digest: "4".repeat(64), retainedAt: 4 },
      { version: "7.4.23", digest: "5".repeat(64), retainedAt: 0 },
    ].map((value) => ({
      version: value.version,
      target: run.target,
      package: join(root, `raya.${value.digest}.vsix`),
      artifact: { digest: value.digest, size: 4 },
      binary: { digest: "a".repeat(64), size: 2 },
      retainedAt: value.retainedAt,
    }))
    await Promise.all(packages.map((value) => writeFile(value.package, "data")))
    await writeFile(join(root, "packages.json"), JSON.stringify({ version: 1, active: "2".repeat(64), packages }))

    expect(await new PackageVault(root).pruneSnapshots({ keep: ["1".repeat(64)], retained: 1 })).toEqual({
      packages: 1,
      bytes: 4,
    })
    const saved = JSON.parse(await readFile(join(root, "packages.json"), "utf8"))
    expect(saved.packages.map((value: { artifact: { digest: string } }) => value.artifact.digest)).toEqual([
      "1".repeat(64),
      "2".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    ])
    await expect(Bun.file(packages[2].package).exists()).resolves.toBeFalse()
    await expect(Bun.file(packages[0].package).exists()).resolves.toBeTrue()
    await expect(Bun.file(packages[1].package).exists()).resolves.toBeTrue()
    await expect(Bun.file(packages[3].package).exists()).resolves.toBeTrue()
    await expect(Bun.file(packages[4].package).exists()).resolves.toBeTrue()
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("retention commits against the latest manifest after package verification", async () => {
  const run = await fixture()
  try {
    const next = await archive(run.root, "1.2.4", "second retained binary", "next.vsix")
    const root = join(run.root, "vault")
    const pause = gate("retain")
    const first = new PackageVault(root, pause.barrier).retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    await pause.entered
    const second = await new PackageVault(root).retain(next.source, {
      name: "raya",
      publisher: "eden",
      version: next.version,
      target: next.target,
    })
    pause.release()
    const saved = await first
    const manifest = JSON.parse(await readFile(join(root, "packages.json"), "utf8"))
    expect(new Set(manifest.packages.map((value: Package) => value.artifact.digest))).toEqual(
      new Set([saved.artifact.digest, second.artifact.digest]),
    )
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("activation preserves packages retained while verification is in progress", async () => {
  const run = await fixture()
  try {
    const next = await archive(run.root, "1.2.4", "second retained binary", "next.vsix")
    const root = join(run.root, "vault")
    const vault = new PackageVault(root)
    const saved = await vault.retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    const binary = join(run.root, "kilo.exe")
    await writeFile(binary, run.binary)
    const pause = gate("activate")
    const active = new PackageVault(root, pause.barrier).activate(run.version, run.target, binary)
    await pause.entered
    const second = await vault.retain(next.source, {
      name: "raya",
      publisher: "eden",
      version: next.version,
      target: next.target,
    })
    pause.release()
    expect(await active).toEqual(saved)
    const manifest = JSON.parse(await readFile(join(root, "packages.json"), "utf8"))
    expect(manifest.active).toBe(saved.artifact.digest)
    expect(new Set(manifest.packages.map((value: Package) => value.artifact.digest))).toEqual(
      new Set([saved.artifact.digest, second.artifact.digest]),
    )
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("adopts a verified digest-named package left by an interrupted manifest write", async () => {
  const run = await fixture()
  try {
    const seed = await new PackageVault(join(run.root, "seed")).retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    const root = join(run.root, "vault")
    await mkdir(root)
    const orphan = join(root, `raya.${seed.artifact.digest}.vsix`)
    await copyFile(seed.package, orphan)
    const saved = await new PackageVault(root).retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    expect(saved.package).toBe(orphan)
    const manifest = JSON.parse(await readFile(join(root, "packages.json"), "utf8"))
    expect(manifest.packages).toEqual([saved])
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("rejects a corrupt digest-named orphan instead of indexing it", async () => {
  const run = await fixture()
  try {
    const seed = await new PackageVault(join(run.root, "seed")).retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    const root = join(run.root, "vault")
    await mkdir(root)
    await writeFile(join(root, `raya.${seed.artifact.digest}.vsix`), "corrupt")
    await expect(
      new PackageVault(root).retain(run.source, {
        name: "raya",
        publisher: "eden",
        version: run.version,
        target: run.target,
      }),
    ).rejects.toThrow()
    await expect(Bun.file(join(root, "packages.json")).exists()).resolves.toBeFalse()
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})

test("pruning removes missing index entries and unindexed digest packages", async () => {
  const run = await fixture()
  try {
    const root = join(run.root, "vault")
    const saved = await new PackageVault(root).retain(run.source, {
      name: "raya",
      publisher: "eden",
      version: run.version,
      target: run.target,
    })
    const next = await archive(run.root, "1.2.4", "orphaned retained binary", "next.vsix")
    const extra = await new PackageVault(join(run.root, "seed")).retain(next.source, {
      name: "raya",
      publisher: "eden",
      version: next.version,
      target: next.target,
    })
    const orphan = join(root, `raya.${extra.artifact.digest}.vsix`)
    await copyFile(extra.package, orphan)
    const missing: Package = {
      ...saved,
      version: "1.2.2",
      package: join(root, `raya.${"f".repeat(64)}.vsix`),
      artifact: { digest: "f".repeat(64), size: 123 },
      retainedAt: saved.retainedAt - 1,
    }
    await writeFile(join(root, "packages.json"), JSON.stringify({ version: 1, packages: [saved, missing] }))
    expect(await new PackageVault(root).pruneSnapshots()).toEqual({ packages: 2, bytes: extra.artifact.size })
    const manifest = JSON.parse(await readFile(join(root, "packages.json"), "utf8"))
    expect(manifest.packages).toEqual([saved])
    const files = (await readdir(root)).filter((file) => /^raya\.[a-f0-9]{64}\.vsix$/.test(file)).sort()
    expect(files).toEqual([`raya.${saved.artifact.digest}.vsix`])
    await expect(Bun.file(saved.package).exists()).resolves.toBeTrue()
    await expect(Bun.file(orphan).exists()).resolves.toBeFalse()
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
})
