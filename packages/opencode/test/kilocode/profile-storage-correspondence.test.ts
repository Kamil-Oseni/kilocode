import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { Codec as Task } from "../../src/kilocode/task/schema"
import { Codec as Goal } from "../../src/kilocode/goal/schema"
import { Codec as Checkpoint } from "../../src/kilocode/checkpoint/schema"
import {
  bindStorage,
  storageGroups,
  validateStorage,
  type StorageClaim,
} from "../../src/kilocode/migration/profile-storage-correspondence"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"

test.skipIf(process.platform !== "win32")(
  "storage claims bind genuine writer schemas to exact native original JSON",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-storage-correspondence-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const id = crypto.randomUUID(),
      session = "ses_storage_fixture"
    const worker = Schema.decodeUnknownSync(Task.Agent)({
      id,
      name: "Café 日本語 😀",
      role: "generalist",
      objective: "Keep content",
      capabilities: [],
      memoryScope: "session",
      schedule: { kind: "manual" },
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    })
    const history = Schema.decodeUnknownSync(Task.History)({
      version: 1,
      cursor: 0,
      runs: [{ id: crypto.randomUUID(), agentID: id, at: 2, sessionID: session, status: "complete" }],
      events: [],
    })
    const goal = Schema.decodeUnknownSync(Goal.State)({
      objective: "Café 日本語 😀",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      usage: { turns: 0, continuations: 0, toolCalls: 0 },
      progress: [],
    })
    const checkpoints = Schema.decodeUnknownSync(Checkpoint.List)([
      { id: crypto.randomUUID(), name: "Café 日本語 😀", hash: "a".repeat(40), createdAt: 2 },
    ])
    const json = [
      { path: "raya/agent.json", value: JSON.stringify([worker]) },
      { path: "raya/agent-initialized.json", value: '{"version":1}' },
      { path: `raya/agent-runs/${id}.json`, value: JSON.stringify(history) },
      { path: `raya/goal/${session}.json`, value: JSON.stringify(goal) },
      { path: `raya/checkpoint/${session}.json`, value: JSON.stringify(checkpoints) },
      { path: "voice/usage-reconciliation/v1.json", value: '{"unknown":"café"}' },
      { path: "raya/composer-drafts-initialized.json", value: '{"version":1}' },
      { path: "raya/goal/ses_unsupported.json", value: JSON.stringify({ ...goal, unsupported: true }) },
      { path: `raya/agent-runs/${crypto.randomUUID()}.json`, value: JSON.stringify(history) },
    ]
    for (const entry of json) {
      const file = path.join(storage, ...entry.path.split("/"))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, entry.value, { flag: "wx" })
    }
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selected = await select({ database, storage }, policy)
    const roles = {
      data,
      config: data,
      cache: data,
      state: data,
      stateParent: data,
      bin: data,
      log: data,
      repos: data,
      homeKilocode: data,
      homeConfigKilo: data,
    }
    const selection = { ...selected, globals: [roles] }
    const retained: { token?: Working; claim?: StorageClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "control", "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const claim = await bindStorage(token, { json })
      retained.token = token
      retained.claim = claim
      const entries = storageGroups(token, claim)
      expect(entries.length).toBe(5)
      expect(new Set(entries.map((entry) => entry.selector.role)).size).toBe(5)
      expect(Object.isFrozen(entries)).toBe(true)
      for (const entry of entries) {
        validateStorage(entry, { json })
        expect(entry.activation).toBe("inert")
        expect(entry.source).toBe(path.join(storage, ...entry.selector.path.split("/")))
      }
      const changed = structuredClone(json)
      changed[0].value = JSON.stringify([{ ...worker, name: "changed" }])
      await assert.rejects(bindStorage(token, { json: changed }), /held original bytes/)
      expect(() => validateStorage(entries[0], { json: changed })).toThrow("component differs")
      expect(() =>
        validateStorage({ ...entries[0], selector: { ...entries[0].selector, role: "goal" } }, { json }),
      ).toThrow()
      expect(() => validateStorage({ ...entries[0], source: path.join(data, "foreign.json") }, { json })).toThrow(
        "original bytes",
      )
      expect(() => storageGroups(token, JSON.parse(JSON.stringify(claim)))).toThrow("another image")
      await assert.rejects(writeFile(path.join(storage, "foreign.json"), "forbidden"))
    })
    expect(() => storageGroups(retained.token!, retained.claim!)).toThrow("expired")
    await capture(async (token) => {
      expect(() => storageGroups(token, retained.claim!)).toThrow("another image")
      const entries = storageGroups(token, await bindStorage(token, { json }))
      expect(entries.length).toBe(5)
    })
    for (const entry of json)
      expect(await readFile(path.join(storage, ...entry.path.split("/")), "utf8")).toBe(entry.value)
  },
  60_000,
)

test("storage schema import does not initialize Global or admit native roots", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-storage-schema-import-")))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(OTEL_|RAYA_|KILO_|KILOCODE_|OPENCODE_|XDG_)|API_KEY|TOKEN|SECRET|PASSWORD/i.test(name),
    ),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      path.join(import.meta.dir, "fixtures", "profile-storage-import.ts"),
      root,
    ],
    {
      env: {
        ...env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        HOME: root,
        USERPROFILE: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        LOCALAPPDATA: path.join(root, "local"),
        KILO_TEST_HOME: root,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  let forced = false
  const timer = setTimeout(() => {
    forced = true
    child.kill()
  }, 15_000)
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  await writeFile(path.join(os.tmpdir(), `raya-storage-schema-import-${child.pid}.log`), err)
  expect(forced).toBe(false)
  expect(code, err).toBe(0)
  expect(out.trim()).toBe("STORAGE_SCHEMA_IMPORT_OK")
}, 20_000)
