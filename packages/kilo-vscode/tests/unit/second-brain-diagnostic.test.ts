import { expect, test } from "bun:test"
import * as vscode from "vscode"
import { diagnostic } from "../../src/second-brain/diagnostic"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainHost } from "../../src/second-brain/host"
import { release, bridge } from "../../src/second-brain/control/catalog-v2"

// Controlled storage adapters exercise actual settings and host code, not native SecretStorage acceptance.
function fixture() {
  const rows = new Map<string, unknown>()
  const keys = new Map<string, string>()
  const calls = { writes: 0, reads: 0, during: () => {} }
  const storage = {
    get<T>(key: string) {
      return rows.get(key) as T | undefined
    },
    async update(key: string, value: unknown) {
      calls.writes++
      rows.set(key, value)
    },
  }
  const secrets = {
    async get(key: string) {
      calls.reads++
      calls.during()
      return keys.get(key)
    },
    async store(key: string, value: string) {
      calls.writes++
      keys.set(key, value)
    },
    async delete(key: string) {
      calls.writes++
      keys.delete(key)
    },
  }
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:8874",
    root: "C:\\Private-Notes",
    source_sha256: release,
  } as const
  const catalog = {
    root: setup.root,
    catalog: {
      format: "raya.memory.control.catalog",
      version: 2,
      python: "C:\\Private-Service\\python.exe",
      source: "C:\\Private-Service\\source",
      bridge: "C:\\Private-Service\\control.py",
      python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
      bridge_sha256: bridge,
      source_sha256: release,
    },
  }
  return { rows, keys, calls, storage, secrets, setup, catalog, settings: new BrainSettings(storage, secrets) }
}

test("unconfigured diagnosis performs no credential reads or persistence", async () => {
  const cfg = fixture()
  expect(await diagnostic(cfg.settings, cfg.storage)).toEqual({
    scope: "configuration-only",
    runtimeAccepted: false,
    status: "unconfigured",
  })
  expect(cfg.calls.writes).toBe(0)
  expect(cfg.calls.reads).toBe(0)
})

test("actual settings configuration returns public fingerprints without paths or credential identity", async () => {
  const cfg = fixture()
  await cfg.settings.save(cfg.setup, "private-credential-A")
  cfg.rows.set("raya.secondBrain.control.catalog", cfg.catalog)
  const before = cfg.calls.writes
  const first = await diagnostic(cfg.settings, cfg.storage)
  expect(first).toMatchObject({ status: "configured", credentialPresent: true, controlSelected: true, managed: false })
  expect(first.runtimeAccepted).toBe(false)
  expect(JSON.stringify(first)).not.toContain("Private")
  expect(JSON.stringify(first)).not.toContain("private-credential")
  expect(JSON.stringify(first)).not.toContain("raya.secondBrain.key")
  expect(cfg.calls.writes).toBe(before)
  await cfg.settings.save(cfg.setup, "private-credential-B")
  const writes = cfg.calls.writes
  expect(await diagnostic(cfg.settings, cfg.storage)).toEqual(first)
  expect(cfg.calls.writes).toBe(writes)
})

test("missing credential and foreign or invalid control catalogs remain unconfirmed", async () => {
  const cfg = fixture()
  await cfg.settings.save(cfg.setup, "private-credential")
  cfg.rows.set("raya.secondBrain.control.catalog", { ...cfg.catalog, root: "C:\\Foreign" })
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
  cfg.rows.set("raya.secondBrain.control.catalog", { ...cfg.catalog, catalog: { private: "private-error-content" } })
  expect(JSON.stringify(await diagnostic(cfg.settings, cfg.storage))).not.toContain("private-error-content")
  cfg.rows.delete("raya.secondBrain.control.catalog")
  cfg.keys.clear()
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
})

test("actual settings and credential races refuse rather than publishing a mixed receipt", async () => {
  const cfg = fixture()
  await cfg.settings.save(cfg.setup, "private-credential")
  const original = structuredClone(cfg.rows.get("raya.secondBrain.setup")) as Record<string, unknown>
  cfg.calls.during = () =>
    cfg.rows.set("raya.secondBrain.setup", { ...original, setup: { ...cfg.setup, origin: "http://127.0.0.1:8875" } })
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
  cfg.rows.set("raya.secondBrain.setup", original)
  cfg.calls.reads = 0
  cfg.calls.during = () => {
    if (cfg.calls.reads === 2) for (const key of cfg.keys.keys()) cfg.keys.set(key, "changed-private-credential")
  }
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
})

test("catalog race and actual pending debt retain their fences without writes", async () => {
  const cfg = fixture()
  await cfg.settings.save(cfg.setup, "private-credential")
  cfg.rows.set("raya.secondBrain.control.catalog", cfg.catalog)
  cfg.calls.during = () => cfg.rows.delete("raya.secondBrain.control.catalog")
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
  cfg.calls.during = () => {}
  cfg.rows.set("raya.secondBrain.control.uncertainty", {
    format: "raya.memory.control.uncertainty",
    version: 2,
    protocol: "raya.memory.operation.v1",
    root: cfg.setup.root,
    request: {
      op: "search",
      id: "a".repeat(32),
      root: cfg.setup.root,
      owner_epoch: "b".repeat(32),
      selected_release_sha256: "c".repeat(64),
      bodySHA: "d".repeat(64),
      source_sha256: release,
    },
  })
  const before = cfg.calls.writes
  const reads = cfg.calls.reads
  expect((await diagnostic(cfg.settings, cfg.storage)).status).toBe("unconfirmed")
  expect(cfg.calls.writes).toBe(before)
  expect(cfg.calls.reads).toBe(reads)
  expect(cfg.rows.has("raya.secondBrain.control.uncertainty")).toBe(true)
})

test("native-host command registers once per real host context and uses its singleton settings", async () => {
  const cfg = fixture()
  const commands: Array<{ name: string; body: () => Promise<unknown> }> = []
  const prior = vscode.commands.registerCommand
  vscode.commands.registerCommand = (name, body) => {
    commands.push({ name, body })
    return { dispose() {} }
  }
  try {
    const context = {
      globalState: cfg.storage,
      secrets: cfg.secrets,
      subscriptions: [],
      extensionPath: "C:\\Private-Extension",
    } as unknown as vscode.ExtensionContext
    new BrainHost(context)
    new BrainHost(context)
    expect(commands.map((command) => command.name)).toEqual([
      "raya.memory.inspectConfiguration",
      "raya.memory.inspectDream",
    ])
    const command = commands.find((command) => command.name === "raya.memory.inspectConfiguration")!
    expect((await command.body()) as { status: string }).toHaveProperty("status", "unconfigured")
    await cfg.settings.save(cfg.setup, "private-credential")
    expect((await command.body()) as { status: string }).toHaveProperty("status", "configured")
  } finally {
    vscode.commands.registerCommand = prior
  }
})
