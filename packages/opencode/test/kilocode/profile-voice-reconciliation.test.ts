import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { Reconciliation } from "../../src/kilocode/voice/reconciliation-schema"
import { reconciliation, voice } from "../../src/kilocode/migration/profile-voice-reconciliation-schema"
import {
  bindVoice,
  readVoice,
  voiceValues,
  voiceGroups,
  validateVoice,
  type VoiceClaim,
} from "../../src/kilocode/migration/profile-voice-reconciliation"
import { payload, seal, unseal } from "../../src/kilocode/migration/profile-bundle"

const state = {
  version: 1 as const,
  cycle: 4,
  high: "retained-binding",
  after: "older-binding",
  status: "failed" as const,
  scanned: 2,
  receipts: 3,
  quarantined: 1,
  updatedAt: 1000,
  failure: {
    id: "retained-binding",
    message: "A retained voice charge could not be published. The same binding will be retried.",
  },
}
test("migration delegates to the shipped voice reconciliation codec and retains only bounded inactive originals", () => {
  expect(reconciliation.parse(state)).toEqual(
    Schema.decodeUnknownSync(Reconciliation, { onExcessProperty: "error" })(state),
  )
  for (const raw of [
    { ...state, version: 2 },
    { ...state, cycle: -1 },
    { ...state, updatedAt: Infinity },
    { ...state, scanned: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, secret: "unclassified" },
    { ...state, failure: { ...state.failure, message: "x".repeat(241) } },
  ]) {
    expect(reconciliation.safeParse(raw).success).toBe(false)
    assert.throws(() => Schema.decodeUnknownSync(Reconciliation, { onExcessProperty: "error" })(raw))
  }
  const root = path.resolve("voice-fixture")
  const evidence = {
    format: "raya.voice-reconciliation-evidence" as const,
    version: 1 as const,
    activation: "inert" as const,
    states: [
      { namespace: "primary", data: root, storage: path.join(root, "storage"), original: JSON.stringify(state), state },
    ],
  }
  expect(voice.parse(evidence).states[0].state).toEqual(state)
  expect(voice.safeParse({ ...evidence, activation: "running" }).success).toBe(false)
  expect(voice.safeParse({ ...evidence, states: [evidence.states[0], evidence.states[0]] }).success).toBe(false)
  expect(
    voice.safeParse({
      ...evidence,
      states: [{ ...evidence.states[0], original: JSON.stringify({ ...state, receipts: 9 }) }],
    }).success,
  ).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "held native voice originals remain inert across encrypted codec hops; unknown and expired claims refuse",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-voice-correspondence-")))
    const data = path.join(root, "data")
    const storage = path.join(data, "storage")
    const extra = path.join(root, "extra")
    const unknown = path.join(root, "unknown")
    const selector = "raya/voice/usage-reconciliation/v1.json"
    for (const dir of [data, extra, unknown])
      await mkdir(path.join(dir, "storage", path.dirname(selector)), { recursive: true })
    const raw = JSON.stringify(state, null, 2) + "\n"
    await writeFile(path.join(storage, selector), raw)
    await writeFile(
      path.join(extra, "storage", selector),
      JSON.stringify({ ...state, status: "running", failure: undefined }),
    )
    await writeFile(path.join(unknown, "storage", selector), JSON.stringify({ ...state, executionAuthority: true }))
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const policy = { version: 1 as const, directories: [data, extra, unknown].sort(), files: [] }
    const selected = await select({ database, storage }, policy)
    const globals = [data, extra, unknown].map((dir) => ({
      data: dir,
      config: dir,
      cache: dir,
      state: dir,
      stateParent: dir,
      bin: dir,
      log: dir,
      repos: dir,
      homeKilocode: dir,
      homeConfigKilo: dir,
    }))
    const selection = {
      ...selected,
      roots: [...selected.roots, ...[extra, unknown].map((dir) => ({ kind: "json" as const, path: dir }))],
      globals,
    }
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const saved: { token?: Working; claim?: VoiceClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const reader = await readVoice(token)
      const value = voiceValues(token, reader)
      assert(value)
      expect(value.states).toHaveLength(2)
      expect(value.states.some((item) => item.data === unknown)).toBe(false)
      expect(value.states.find((item) => item.namespace === "primary")?.original).toBe(raw)
      expect(Object.isFrozen(value.states[0].state.failure)).toBe(true)
      const claim = bindVoice(token, reader, { voice: value })
      saved.token = token
      saved.claim = claim
      const groups = voiceGroups(token, claim)
      expect(groups).toHaveLength(2)
      for (const entry of groups) validateVoice(entry, { voice: value })
      expect(groups.every((item) => item.activation === "inert" && item.rawBytesPreserved)).toBe(true)
      assert.throws(() => voiceGroups(token, { ...claim }), /claim/)
      assert.throws(() => voiceValues(token, { ...reader }), /reader/)
      const tampered = {
        ...value,
        states: value.states.map((item, index) =>
          index
            ? item
            : {
                ...item,
                state: { ...item.state, receipts: item.state.receipts + 1 },
              },
        ),
      }
      assert.throws(() => bindVoice(token, reader, { voice: tampered }), /actual held reader/)
      assert.throws(
        () => validateVoice({ ...groups[0], source: path.join(data, "different.json") }, { voice: value }),
        /physical selector/,
      )
      assert.throws(() => validateVoice({ ...groups[0], digest: "0".repeat(64) }, { voice: value }), /bytes differ/)
      await assert.rejects(writeFile(path.join(storage, selector), "{}"))
      const input = payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: randomUUID(),
        createdAt: Date.now(),
        schema: "a".repeat(64),
        workspaces: [],
        sql: [],
        json: [],
        voice: value,
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      const first = await unseal(
        await seal(input, "first voice inert fixture password"),
        "first voice inert fixture password",
      )
      const second = await unseal(
        await seal(first, "second voice inert fixture password"),
        "second voice inert fixture password",
      )
      expect(second.voice).toEqual(value)
      expect(second.voice?.states.find((item) => item.namespace === "primary")?.original).toBe(raw)
      await writeFile(path.join(root, "voice-input.json"), JSON.stringify(input))
    })
    assert(saved.token && saved.claim)
    assert.throws(() => voiceGroups(saved.token!, saved.claim!), /expired|closed|unavailable/)
    await capture(async (token) => assert.throws(() => voiceGroups(token, saved.claim!), /another image/))
    expect(await readFile(path.join(storage, selector), "utf8")).toBe(raw)
    const home = path.join(root, "home")
    await mkdir(home)
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|TOKEN|SECRET|API_KEY|PASSWORD/i.test(key),
      ),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-voice-reconciliation-restore.ts"),
        root,
      ],
      {
        env: {
          ...inherited,
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
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
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
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    await writeFile(path.join(root, "restore-stdout.log"), out)
    await writeFile(path.join(root, "restore-stderr.log"), err)
    expect(deadline.forced).toBe(false)
    expect(code, err).toBe(0)
    assert.throws(() => process.kill(child.pid, 0))
    expect(JSON.parse(await readFile(path.join(root, "voice-restore-receipt.json"), "utf8"))).toMatchObject({
      passed: true,
      encryptedInactiveHops: 2,
      originalStateExact: true,
      historicalStateExact: true,
      activeReconciliationFileCreated: false,
    })
  },
  90000,
)
