import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  bindMemory,
  memoryGroups,
  memoryValues,
  readMemory,
  validateMemory,
  type MemoryClaim,
} from "../../src/kilocode/migration/profile-memory-correspondence"
import { memories } from "../../src/kilocode/migration/profile-memory"
import { payload, seal, unseal } from "../../src/kilocode/migration/profile-bundle"

test.skipIf(process.platform !== "win32")(
  "actual memory writers bind only held native bytes and inert lossless state across encrypted hops",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-correspondence-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage"),
      workspace = path.join(root, "workspace")
    await mkdir(storage, { recursive: true })
    await mkdir(workspace)
    const id = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
    const dir = path.join(data, "memory", id.folder)
    await MemoryFiles.scaffold(dir, id)
    await writeFile(MemoryPaths.files(dir).state, "{")
    expect((await MemoryFiles.readState(dir)).enabled).toBe(false)
    await MemoryFiles.writeState(dir, MemorySchema.create())
    await MemoryFiles.writeSource(dir, "project.md", "# Project\ncafé 日本語 😀\n")
    await MemoryFiles.writeSource(dir, "environment.md", "# Environment\nprivate offline fixture\n")
    await MemoryFiles.writeSource(dir, "corrections.md", "# Corrections\npreserve exact content\n")
    await MemoryFiles.writeSession(dir, {
      sessionID: "native-held-memory",
      summary: "session café 日本語 😀",
      max: 10000,
      time: 1000,
    })
    // Legacy decisions are currently compatibility no-op writers; exact historical fixture bytes are qualified separately.
    await writeFile(path.join(dir, "decisions.jsonl"), '{"historical":"inactive"}\n')
    await writeFile(path.join(dir, "index.kmem"), "derived index intentionally unclassified")
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_TEST_TIMESTAMP_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selected = await select({ database, storage }, policy)
    const selection = {
      ...selected,
      globals: [
        {
          data,
          config: data,
          cache: data,
          state: storage,
          stateParent: data,
          bin: data,
          log: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
      ],
    }
    const saved: { token?: Working; claim?: MemoryClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest: createHash("sha256").update(awaited).digest("hex") },
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    const awaited = await readFile(helper)
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const value = memoryValues(token, reader)
      const claim = bindMemory(token, [reader], { memory: value })
      saved.token = token
      saved.claim = claim
      const groups = memoryGroups(token, claim)
      expect(groups.filter((entry) => entry.rawBytesPreserved)).toHaveLength(6)
      expect(groups.filter((entry) => !entry.rawBytesPreserved)).toHaveLength(2)
      expect(groups.every((entry) => entry.activation === "inert")).toBe(true)
      expect(groups.some((entry) => entry.source.endsWith("index.kmem") || entry.source.endsWith(".gitignore"))).toBe(
        false,
      )
      for (const entry of groups) validateMemory(entry, { memory: value })
      const backup = groups.find((entry) => entry.selector.kind === "quarantine")
      assert(backup)
      expect(value[0].quarantine).toHaveLength(1)
      expect(value[0].quarantine![0].text).toBe("{")
      expect(await readFile(backup.source, "utf8")).toBe("{")
      expect(backup.rawBytesPreserved).toBe(true)
      assert.throws(() => validateMemory({ ...backup, digest: "0".repeat(64) }, { memory: value }), /original bytes/)
      assert.throws(() => validateMemory({ ...backup, rawBytesPreserved: false }, { memory: value }), /original bytes/)
      assert.throws(
        () => validateMemory({ ...backup, source: path.join(data, "state.json.bad-0") }, { memory: value }),
        /physical selector/,
      )
      const omitted = structuredClone(value)
      delete omitted[0].quarantine
      assert.throws(() => bindMemory(token, [reader], { memory: omitted }), /actual held reader/)
      assert.throws(() => bindMemory(token, [{ ...reader }], { memory: value }), /reader/)
      assert.throws(() => memoryGroups(token, { ...claim }), /claim/)
      const altered = structuredClone(value)
      altered[0].sources["project.md"] += " changed"
      assert.throws(() => bindMemory(token, [reader], { memory: altered }), /actual held reader/)
      assert.throws(() => validateMemory({ ...groups[0], digest: "0".repeat(64) }, { memory: value }), /bytes differ/)
      assert.throws(
        () => validateMemory({ ...groups[0], source: path.join(data, "outside.md") }, { memory: value }),
        /physical selector/,
      )
      const value1 = payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: randomUUID(),
        createdAt: Date.now(),
        schema: "a".repeat(64),
        workspaces: [workspace],
        sql: [],
        json: [],
        memory: value,
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      const first = await unseal(
        await seal(value1, "memory first inert encrypted key"),
        "memory first inert encrypted key",
      )
      const second = await unseal(
        await seal(first, "memory second inert encrypted key"),
        "memory second inert encrypted key",
      )
      expect(second.memory).toEqual(value)
      expect(second.memory[0].lineage!.records).toHaveLength(2)
      expect(second.memory[0].state).toBe(JSON.stringify(MemorySchema.persist(MemorySchema.create())))
      await writeFile(path.join(root, "memory-input.json"), JSON.stringify(value1))
    })
    assert.throws(() => memoryGroups(saved.token!, saved.claim!), /closed|expired|unavailable/)
    await capture(async (other) => assert.throws(() => memoryGroups(other, saved.claim!), /another image/))
    const home = path.join(root, "home")
    await mkdir(home)
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-memory-correspondence.ts"),
        root,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          KILO_TEST_HOME: home,
          LOCALAPPDATA: path.join(root, "local"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          RAYA_DB: path.join(home, "unused.db"),
          KILO_DB: path.join(home, "unused.db"),
          RAYA_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const deadline = { forced: false }
    const timer = setTimeout(() => {
      deadline.forced = true
      child.kill()
    }, 30000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "restore-stdout.log"), stdout)
    await writeFile(path.join(root, "restore-stderr.log"), stderr)
    expect(deadline.forced).toBe(false)
    expect(code, stderr).toBe(0)
    assert.throws(() => process.kill(child.pid, 0))
    expect(JSON.parse(await readFile(path.join(root, "memory-restore-receipt.json"), "utf8"))).toMatchObject({
      passed: true,
      encryptedInactiveHops: 2,
      originalLineageExact: true,
      replayActivated: false,
    })
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"))
    state.unrecognized = "unknown current setting"
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state))
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const values = memoryValues(token, reader)
      const claim = bindMemory(token, [reader], { memory: values })
      expect(memoryGroups(token, claim).some((entry) => entry.selector.kind === "state")).toBe(false)
      expect(values).toHaveLength(1)
    })
    await writeFile(path.join(dir, "unknown-control.json"), '{"unexpected":true}')
    await capture(async (token) => assert.rejects(readMemory(token, data), /unsupported entries/))
  },
  90000,
)

test("declared held memory identity uses the exact shipped canonical folder without reading old repository metadata", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-declared-")))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  const id = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
  expect(MemoryPaths.declared(id.canonical)).toEqual(id)
  const dir = path.join(root, "memory", id.folder)
  await MemoryFiles.scaffold(dir, id)
  const other = path.join(root, "other", ".git")
  await mkdir(other, { recursive: true })
  await mkdir(path.join(workspace, ".git"))
  await writeFile(path.join(workspace, ".git", "commondir"), other)
  expect(MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } }).canonical).not.toBe(id.canonical)
  expect((await memories(path.join(root, "memory")))[0].workspace).toBe(id.canonical)
  expect(() => MemoryPaths.declared("relative")).toThrow()
})
