import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { MemoryIndexer } from "../../../kilo-memory/src/recall/indexer"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  bindMemory,
  memoryGroups,
  readMemory,
  memoryValues,
  validateMemory,
} from "../../src/kilocode/migration/profile-memory-correspondence"
import { payload } from "../../src/kilocode/migration/profile-bundle"
import {
  bindMemoryDerived,
  memoryDerived,
  memoryDerivedGroups,
  validateMemoryDerived,
  type MemoryDerivedClaim,
} from "../../src/kilocode/migration/profile-memory-derived"
import {
  bindHold,
  holdGroups,
  validateHold,
  type HoldClaim,
} from "../../src/kilocode/migration/profile-restore-hold-correspondence"

test("native timestamp evidence rejects malformed ticks without throwing conversion errors", () => {
  const schema = memoryDerived.shape.inputs.element.shape.ticks
  for (const value of ["1.5", "-1", "", "18446744073709551616", "1".repeat(21)]) {
    expect(schema.safeParse(value).success).toBe(false)
    assert.throws(
      () => schema.parse(value),
      (err) => err instanceof Error && err.name === "ZodError",
    )
  }
  expect(schema.parse("0")).toBe("0")
  expect(schema.parse("18446744073709551615")).toBe("18446744073709551615")
  expect(schema.parse(undefined)).toBeUndefined()
})

test.skipIf(process.platform !== "win32")(
  "actual derived memory writer bytes bind immutable image; stale/customized files stay unknown",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-derived-")))
    const data = path.join(root, "data"),
      storage = path.join(data, "storage"),
      workspace = path.join(root, "workspace")
    await mkdir(storage, { recursive: true })
    await mkdir(workspace)
    const id = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
    const dir = path.join(data, "memory", id.folder)
    await MemoryFiles.scaffold(dir, id)
    await MemoryFiles.writeState(dir, MemorySchema.create())
    await MemoryFiles.writeSource(dir, "project.md", "# Project Memory\n\nSession-only fixture café 日本語 😀\n")
    await MemoryFiles.writeSession(dir, {
      sessionID: "derived-held-session",
      summary: "preserved café 日本語 😀",
      max: 10000,
      time: 1000,
    })
    await MemoryIndexer.rebuild({ root: dir })
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
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
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
    const capture = (body: (token: Working) => Promise<void>, inventory?: "directories") =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "registry"),
          inventory,
        },
        (image) => withWorking(image, selection, body),
      )
    const saved: { token?: Working; claim?: MemoryDerivedClaim } = {}
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const memory = memoryValues(token, reader)
      const held = await bindHold(token, { memory })
      expect(holdGroups(token, held)).toHaveLength(0)
      const claim = await bindMemoryDerived(token, { memory })
      saved.token = token
      saved.claim = claim
      const groups = memoryDerivedGroups(token, claim)
      expect(groups.map((item) => item.selector).sort()).toEqual(["ignore", "index"])
      for (const item of groups) validateMemoryDerived(item, { memory })
      const original = payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: randomUUID(),
        createdAt: Date.now(),
        schema: "a".repeat(64),
        workspaces: [workspace],
        sql: [],
        json: [],
        memory,
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      await writeFile(path.join(root, "memory-input.json"), JSON.stringify(original))
      assert.throws(() => memoryDerivedGroups(token, { ...claim }), /absent|foreign/)
      assert.throws(
        () => validateMemoryDerived({ ...groups[0], digest: "0".repeat(64) }, { memory }),
        /evidence|scaffold/,
      )
      const changed = structuredClone(memory)
      changed[0].sources["project.md"] += " changed"
      await assert.rejects(bindMemoryDerived(token, { memory: changed }), /actual held reader/)
    })
    assert.throws(() => memoryDerivedGroups(saved.token!, saved.claim!), /expired|unavailable/)
    await capture(async (token) => assert.throws(() => memoryDerivedGroups(token, saved.claim!), /foreign/))
    await MemoryFiles.writeSource(
      dir,
      "project.md",
      "# Project Memory\n\n## Facts\n- safe :: timestamped fact café 日本語 😀\n",
    )
    const prior = new Date("2000-01-01T12:00:00.000Z")
    await utimes(path.join(dir, "project.md"), prior, prior)
    await MemoryIndexer.rebuild({ root: dir })
    await writeFile(path.join(dir, ".gitignore"), "customized pattern\n")
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const claim = await bindMemoryDerived(token, { memory: memoryValues(token, reader) })
      expect(memoryDerivedGroups(token, claim).map((item) => item.selector)).toEqual(["index"])
    })
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const claim = await bindMemoryDerived(token, { memory: memoryValues(token, reader) })
      expect(memoryDerivedGroups(token, claim)).toHaveLength(0)
    }, "directories")

    // Same bytes with a newer source timestamp must not validate the old index.
    await utimes(path.join(dir, "project.md"), prior, new Date("2001-01-01T12:00:00.000Z"))
    await capture(async (token) => {
      const reader = await readMemory(token, data)
      const claim = await bindMemoryDerived(token, { memory: memoryValues(token, reader) })
      expect(memoryDerivedGroups(token, claim)).toHaveLength(0)
    })

    const home = path.join(root, "home")
    await mkdir(home)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(name),
      ),
    )
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
          ...env,
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
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
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
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "restore-stdout.log"), out)
    await writeFile(path.join(root, "restore-stderr.log"), err)
    expect(deadline.forced).toBe(false)
    expect(code, err).toBe(0)
    assert.throws(() => process.kill(child.pid, 0))
    const held: { token?: Working; claim?: HoldClaim } = {}
    for (const [target, mapped] of [
      ["first", "mapped-first"],
      ["second", "mapped-second"],
    ]) {
      const current = MemoryPaths.identity({
        ctx: { directory: path.join(root, mapped), worktree: path.join(root, mapped) },
      })
      const destination = path.join(root, target, "data/kilo/memory", current.folder)
      expect(await readFile(path.join(destination, ".gitignore"), "utf8")).toBe("*\n!.gitignore\n")
      const rendered = await MemoryIndexer.build({ root: destination })
      expect(await readFile(path.join(destination, "index.kmem"), "utf8")).toBe(rendered.text)
      expect((await MemoryFiles.readState(destination)).enabled).toBe(false)
      const data = path.join(root, target, "data/kilo")
      const storage = path.join(data, "storage")
      const receipt = path.join(storage, "raya", "restore-hold.json")
      const before = await readFile(receipt, "utf8")
      const policy = { version: 1 as const, directories: [data], files: [] }
      const selected = await select({ database: path.join(data, "raya.db"), storage }, policy)
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
      await withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "destination-control", target),
        },
        (image) =>
          withWorking(image, selection, async (token) => {
            const reader = await readMemory(token, data)
            const memory = memoryValues(token, reader)
            if (held.claim) assert.throws(() => holdGroups(token, held.claim!), /another held image/)
            const hold = await bindHold(token, { memory })
            held.token = token
            held.claim = hold
            const groups = holdGroups(token, hold)
            expect(groups).toHaveLength(1)
            const group = groups[0]
            expect(group.source).toBe(receipt)
            expect(group.bytes).toBe(Buffer.byteLength(before))
            expect(group.digest).toBe(createHash("sha256").update(before).digest("hex"))
            expect(group.activation).toBe("inert")
            expect(group.dev).toMatch(/^\d+$/)
            expect(group.ino).toMatch(/^\d+$/)
            validateHold(group, { memory })
            assert.throws(() => holdGroups(token, JSON.parse(JSON.stringify(hold))), /another held image/)
            assert.throws(() => validateHold({ ...group, digest: "0".repeat(64) }, { memory }), /source bytes/)
            assert.throws(() => validateHold({ ...group, componentDigest: "0".repeat(64) }, { memory }), /component/)
            assert.throws(
              () => validateHold({ ...group, source: path.join(root, "outside.json") }, { memory }),
              /selector/,
            )
            const missing = memory.map((value) => ({ ...value, review: undefined }))
            expect(holdGroups(token, await bindHold(token, { memory: missing }))).toHaveLength(0)
            const changed = structuredClone(memory)
            changed[0].review!.receipt.id = randomUUID()
            assert.throws(() => validateHold(group, { memory: changed }), /review|identity/)
            const marker = structuredClone(memory)
            marker[0].review!.markerText += " "
            marker[0].review!.markerDigest = createHash("sha256").update(marker[0].review!.markerText).digest("hex")
            await assert.rejects(bindHold(token, { memory: marker }), /native marker/)
            expect(JSON.parse(memory[0].state).autoInject).toBe(false)
            const content = bindMemory(token, [reader], { memory })
            const state = memoryGroups(token, content).find((item) => item.selector.kind === "state")
            expect(state).toBeDefined()
            validateMemory(state!, { memory })
            const review = memoryGroups(token, content).find((item) => item.selector.kind === "review")
            expect(review).toBeDefined()
            validateMemory(review!, { memory })
            expect(memory[0].review?.activation).toBe("inert")
            expect(memory[0].review?.receipt.state).toBe("held")
            expect(memory[0].review?.marker.hold).toBe(memory[0].review?.receipt.id)
            assert.throws(() => validateMemory({ ...review!, digest: "0".repeat(64) }, { memory }))
            assert.throws(() => bindMemory(token, [JSON.parse(JSON.stringify(reader))], { memory }))
            const claim = await bindMemoryDerived(token, { memory })
            const index = memoryDerivedGroups(token, claim).find((item) => item.selector === "index")
            expect(index).toBeDefined()
            validateMemoryDerived(index!, { memory })
            expect(index!.sourceTimestampAuthority).toBe(false)
            assert.throws(() => validateMemoryDerived({ ...index!, digest: "0".repeat(64) }, { memory }))
          }),
      )
      assert.throws(() => holdGroups(held.token!, held.claim!), /expired|unavailable/)
      expect(await readFile(receipt, "utf8")).toBe(before)
      expect(JSON.parse(before).state).toBe("held")
      expect((await MemoryFiles.readState(destination)).enabled).toBe(false)
    }
  },
  90000,
)
