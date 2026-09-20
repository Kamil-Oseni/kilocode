import { afterAll, beforeAll, expect, test } from "bun:test"
import { createWriteStream } from "node:fs"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { Readable } from "node:stream"
import type { Package } from "../../src/services/package-vault"
import { Installation, type InstallRequest } from "../../src/services/update-installation"
import { inspect } from "../../src/services/update-vsix"

const require = createRequire(import.meta.url)
const writer = createRequire(require.resolve("@vscode/vsce"))("yazl") as {
  ZipFile: new () => { addBuffer(buffer: Buffer, name: string): void; end(): void; outputStream: Readable }
}
const target = `${process.platform}-${process.arch}`
let fixtureRoot = ""
let rollbackPath = ""
let rollbackReceipt: Awaited<ReturnType<typeof inspect>>

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "raya-installation-fixture-"))
  rollbackPath = join(fixtureRoot, "rollback.vsix")
  const zip = new writer.ZipFile()
  zip.addBuffer(
    Buffer.from(JSON.stringify({ name: "raya", publisher: "eden", version: "1.2.2" })),
    "extension/package.json",
  )
  zip.addBuffer(
    Buffer.from(
      `<PackageManifest><Metadata><Identity Id="raya" Publisher="eden" Version="1.2.2" TargetPlatform="${target}" /></Metadata></PackageManifest>`,
    ),
    "extension.vsixmanifest",
  )
  zip.addBuffer(Buffer.from("rollback binary"), `extension/bin/${process.platform === "win32" ? "kilo.exe" : "kilo"}`)
  const done = pipeline(zip.outputStream, createWriteStream(rollbackPath))
  zip.end()
  await done
  rollbackReceipt = await inspect(rollbackPath, { name: "raya", publisher: "eden", version: "1.2.2", target })
})

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

const memory = () => {
  const state: { value?: unknown } = {}
  return {
    state,
    store: {
      get: () => state.value,
      update: async (_key: string, value: unknown) => {
        state.value = value
      },
    },
  }
}

const input = (root: string, digest = "a".repeat(64)): InstallRequest => ({
  schema: 3,
  version: "1.2.3",
  previous: "1.2.2",
  repo: "eden/raya",
  target,
  asset: {
    name: "raya-win32-x64.vsix",
    url: "https://api.github.com/repos/eden/raya/releases/assets/123",
    size: 42,
    digest: `sha256:${digest}`,
  },
  artifact: { digest, size: 42 },
  binary: { digest: "b".repeat(64), size: 22 },
  package: join(root, `raya.${digest}.vsix`),
  rollback: {
    version: "1.2.2",
    target,
    package: rollbackPath,
    artifact: rollbackReceipt.artifact,
    binary: rollbackReceipt.binary,
  },
})

function active(value: InstallRequest, restored = false): Package {
  const receipt = restored
    ? value.rollback
    : { version: value.version, target: value.target, artifact: value.artifact, binary: value.binary }
  return { ...receipt, package: restored ? value.rollback.package : value.package, retainedAt: 1 }
}

test("retains an interrupted dispatch and never replays its uncertain side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const first = memory()
  try {
    await expect(
      new Installation(first.store, root).run(input(root), async () => {
        throw new Error("installer acknowledgement lost")
      }),
    ).rejects.toThrow("acknowledgement lost")

    const reopened = new Installation(memory().store, root)
    expect(await reopened.recover()).toMatchObject({ phase: "installing", version: "1.2.3" })
    let replayed = false
    expect(
      await reopened.run(input(root), async () => {
        replayed = true
      }),
    ).toMatchObject({ dispatched: false, record: { phase: "installing" } })
    expect(replayed).toBe(false)
    expect(await reopened.recover(active(input(root)))).toBeUndefined()
    await expect(readFile(join(root, "update-installation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed intent write prevents installation dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  let dispatched = false
  const journal = new Installation(
    {
      get: () => undefined,
      update: async () => {
        throw new Error("write failed")
      },
    },
    root,
  )
  try {
    await expect(
      journal.run(input(root), async () => {
        dispatched = true
      }),
    ).rejects.toThrow("write failed")
    expect(dispatched).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a release asset and retained package receipt must identify the same bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  let dispatched = false
  try {
    const mismatched = { ...input(root), artifact: { digest: "b".repeat(64), size: 42 } }
    expect(() =>
      new Installation(memory().store, root).run(mismatched, async () => {
        dispatched = true
      }),
    ).toThrow("receipt does not match")
    expect(dispatched).toBe(false)
    await expect(readFile(join(root, "update-installation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the rollback package must match the active version and platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  let dispatched = false
  try {
    const version = { ...input(root), rollback: { ...input(root).rollback, version: "1.2.1" } }
    expect(() =>
      new Installation(memory().store, root).run(version, async () => {
        dispatched = true
      }),
    ).toThrow("rollback package does not match")
    const target = { ...input(root), rollback: { ...input(root).rollback, target: "linux-x64" } }
    expect(() => new Installation(memory().store, root).run(target, async () => undefined)).toThrow(
      "rollback package does not match",
    )
    expect(dispatched).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completion-write failure retains uncertainty and malformed records are not erased", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const saved = memory()
  let writes = 0
  let installs = 0
  const journal = new Installation(
    {
      get: saved.store.get,
      update: async (_key, value) => {
        if (++writes === 2) throw new Error("completion persistence failed")
        saved.state.value = value
      },
    },
    root,
  )
  try {
    await expect(
      journal.run(input(root), async () => {
        installs++
      }),
    ).rejects.toThrow("completion persistence failed")
    expect(installs).toBe(1)
    expect(await journal.recover()).toMatchObject({ phase: "installing" })
    await writeFile(join(root, "update-installation.json"), JSON.stringify({ malformed: true }))
    await expect(journal.recover(active(input(root)))).rejects.toThrow("invalid")
    expect(writes).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a malformed filesystem record is retained and a changed package cannot take over", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const path = join(root, "update-installation.json")
  try {
    await writeFile(path, "not json")
    await expect(new Installation(memory().store, root).recover()).rejects.toThrow("invalid")
    expect(await readFile(path, "utf8")).toBe("not json")
    await rm(path)
    const journal = new Installation(memory().store, root)
    await journal.run(input(root), async () => undefined)
    await expect(journal.run(input(root, "b".repeat(64)), async () => undefined)).rejects.toThrow(
      "different verified package",
    )
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      phase: "awaiting-reload",
      artifact: { digest: "a".repeat(64) },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function child(root: string, log: string, mode: "complete" | "fail" | "rollback-complete" | "rollback-fail") {
  const path = join(import.meta.dir, "../fixtures/update-installation-child.ts")
  const proc = Bun.spawn([process.execPath, path, root, log, mode, rollbackPath], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("one filesystem owner dispatches across independent extension processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-process-"))
  const log = join(root, "dispatches.log")
  try {
    const results = await Promise.all([child(root, log, "complete"), child(root, log, "complete")])
    expect(results.map((value) => value.code)).toEqual([0, 0])
    expect(results.map((value) => JSON.parse(value.stdout).dispatched).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ])
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toHaveLength(1)
    expect(await new Installation(memory().store, root).recover()).toMatchObject({
      phase: "awaiting-reload",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a second process suppresses replay after installer acknowledgement is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-process-"))
  const log = join(root, "dispatches.log")
  try {
    const failed = await child(root, log, "fail")
    expect(failed.code).toBe(2)
    const retry = await child(root, log, "complete")
    expect(retry.code).toBe(0)
    expect(JSON.parse(retry.stdout)).toMatchObject({ dispatched: false, phase: "installing" })
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("dispatches one exact rollback and verifies it only after the restored host starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-rollback-"))
  const journal = new Installation(memory().store, root)
  try {
    const source = join(root, "vault-package.vsix")
    await copyFile(rollbackPath, source)
    const value = { ...input(root), rollback: { ...input(root).rollback, package: source } }
    await journal.run(value, async () => undefined)
    await rm(source)
    const paths: string[] = []
    expect(
      await journal.rollback(async (path) => {
        paths.push(path)
      }),
    ).toMatchObject({ dispatched: true, record: { phase: "rollback-awaiting-reload" } })
    expect(paths).toHaveLength(1)
    expect(paths[0]).toStartWith(join(root, "update-rollback"))
    expect(
      await new Installation(memory().store, root).rollback(async (path) => {
        paths.push(path)
      }),
    ).toMatchObject({ dispatched: false, record: { phase: "rollback-awaiting-reload" } })
    expect(paths).toHaveLength(1)
    expect(await journal.recover(active(value))).toMatchObject({ phase: "rollback-awaiting-reload" })
    expect(await journal.recover(active(value, true))).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retains uncertain rollback without replay after acknowledgement is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-rollback-"))
  const journal = new Installation(memory().store, root)
  try {
    await journal.run(input(root), async () => undefined)
    await expect(
      journal.rollback(async () => {
        throw new Error("rollback acknowledgement lost")
      }),
    ).rejects.toThrow("acknowledgement lost")
    let replayed = false
    expect(
      await new Installation(memory().store, root).rollback(async () => {
        replayed = true
      }),
    ).toMatchObject({ dispatched: false, record: { phase: "rollback-unknown" } })
    expect(replayed).toBe(false)
    expect(await journal.recover(active(input(root), true))).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a missing journal-owned package blocks rollback before dispatch without changing its phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-rollback-"))
  const journal = new Installation(memory().store, root)
  try {
    await journal.run(input(root), async () => undefined)
    const saved = JSON.parse(await readFile(join(root, "update-installation.json"), "utf8"))
    await rm(saved.rollback.package)
    let dispatched = false
    await expect(
      journal.rollback(async () => {
        dispatched = true
      }),
    ).rejects.toThrow()
    expect(dispatched).toBe(false)
    expect(JSON.parse(await readFile(join(root, "update-installation.json"), "utf8"))).toMatchObject({
      phase: "awaiting-reload",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses an escaped rollback path and retains legacy journals without authorizing side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-record-"))
  const path = join(root, "update-installation.json")
  try {
    const journal = new Installation(memory().store, root)
    await journal.run(input(root), async () => undefined)
    const escaped = JSON.parse(await readFile(path, "utf8"))
    escaped.rollback.package = rollbackPath
    await writeFile(path, JSON.stringify(escaped))
    await expect(journal.recover()).rejects.toThrow("outside its durable update journal")
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ rollback: { package: rollbackPath } })

    const value = input(root)
    await writeFile(
      path,
      JSON.stringify({ ...value, schema: 2, binary: undefined, rollback: undefined, phase: "installing" }),
    )
    expect(await journal.recover(active(value))).toMatchObject({ schema: 2, phase: "installing" })
    await expect(journal.run(value, async () => undefined)).rejects.toThrow("different verified package")
    await expect(journal.rollback(async () => undefined)).rejects.toThrow("No verified Raya rollback package")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("one process dispatches rollback across independent extension hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-rollback-process-"))
  const log = join(root, "rollbacks.log")
  try {
    await new Installation(memory().store, root).run(input(root), async () => undefined)
    const results = await Promise.all([child(root, log, "rollback-complete"), child(root, log, "rollback-complete")])
    expect(results.map((value) => value.code)).toEqual([0, 0])
    expect(results.map((value) => JSON.parse(value.stdout).dispatched).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ])
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
