import { expect, spyOn, test } from "bun:test"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import * as vscode from "vscode"
import { PackageVault } from "../../src/services/package-vault"
import { reconcile } from "../../src/services/update-checker"
import { Installation, type InstallRequest } from "../../src/services/update-installation"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}

async function archive(root: string, version: string, text: string) {
  const source = join(root, `${version}.vsix`)
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
  const root = await mkdtemp(join(tmpdir(), "raya-update-checker-"))
  const vault = new PackageVault(join(root, "package-vault"))
  const previous = await archive(root, "1.2.2", "previous verified binary")
  const next = await archive(root, "1.2.3", "next verified binary")
  const rollback = await vault.retain(previous.source, {
    name: "raya",
    publisher: "eden",
    version: previous.version,
    target: previous.target,
  })
  const retained = await vault.retain(next.source, {
    name: "raya",
    publisher: "eden",
    version: next.version,
    target: next.target,
  })
  const input: InstallRequest = {
    schema: 3,
    version: next.version,
    previous: previous.version,
    repo: "eden/raya",
    target: next.target,
    asset: {
      name: `raya-${next.target}.vsix`,
      url: "https://api.github.com/repos/eden/raya/releases/assets/123",
      size: retained.artifact.size,
      digest: `sha256:${retained.artifact.digest}`,
    },
    artifact: retained.artifact,
    binary: retained.binary,
    package: retained.package,
    rollback,
  }
  await new Installation(memory(), root).run(input, async () => undefined)
  return { root, previous, next, input }
}

function memory() {
  const state = new Map<string, unknown>()
  return {
    get: (key: string) => state.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) state.delete(key)
      else state.set(key, value)
    },
  }
}

function context(root: string, version: string): vscode.ExtensionContext {
  return {
    extension: { packageJSON: { version } },
    extensionUri: vscode.Uri.file(join(root, "extension")),
    globalStorageUri: vscode.Uri.file(root),
    globalState: memory(),
  } as unknown as vscode.ExtensionContext
}

async function binary(root: string, value: Uint8Array) {
  const dir = join(root, "extension", "bin")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, process.platform === "win32" ? "kilo.exe" : "kilo"), value)
}

test("dispatches the journal-owned rollback once and clears only after exact restored activation", async () => {
  const run = await fixture()
  const warning = spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Restore previous" as never)
  const notice = spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Later" as never)
  const commands: Array<{ id: string; path?: string }> = []
  const command = spyOn(vscode.commands, "executeCommand").mockImplementation(async (id, ...args) => {
    commands.push({ id, path: (args[0] as vscode.Uri | undefined)?.fsPath })
  })
  try {
    await binary(run.root, run.previous.binary)
    const ctx = context(run.root, run.previous.version)
    await reconcile(ctx, () => true)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ id: "workbench.extensions.installExtension" })
    expect(commands[0]?.path).toStartWith(join(run.root, "update-rollback"))
    expect(JSON.parse(await readFile(join(run.root, "update-installation.json"), "utf8"))).toMatchObject({
      phase: "rollback-awaiting-reload",
    })
    warning.mockResolvedValue("Later" as never)
    await reconcile(ctx, () => true)
    await expect(Bun.file(join(run.root, "update-installation.json")).exists()).resolves.toBeFalse()
    await expect(Bun.file(join(run.root, "update-rollback")).exists()).resolves.toBeFalse()
    expect(commands).toHaveLength(1)
  } finally {
    warning.mockRestore()
    notice.mockRestore()
    command.mockRestore()
    await rm(run.root, { recursive: true, force: true })
  }
})

test("clears a forward intent only after the exact target package and installed CLI verify", async () => {
  const run = await fixture()
  const warning = spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Later" as never)
  try {
    await binary(run.root, run.previous.binary)
    const ctx = context(run.root, run.next.version)
    await expect(reconcile(ctx, () => true)).rejects.toThrow("approval")
    expect(warning).not.toHaveBeenCalled()
    expect(await new Installation(memory(), run.root).recover()).toMatchObject({ phase: "awaiting-reload" })
    await binary(run.root, run.next.binary)
    await reconcile(ctx, () => true)
    await expect(Bun.file(join(run.root, "update-installation.json")).exists()).resolves.toBeFalse()
  } finally {
    warning.mockRestore()
    await rm(run.root, { recursive: true, force: true })
  }
})
