import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { payload, snapshot, seal, unseal } from "../../src/kilocode/migration/profile-bundle"
import { exportProfile } from "../../src/kilocode/migration/profile-export"
import { withCapture } from "../../src/kilocode/migration/capture-authority"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { memories } from "../../src/kilocode/migration/profile-memory"

function value() {
  return payload.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    schema: "a".repeat(64),
    workspaces: [],
    sql: [],
    json: [{ path: "raya/goal/example.json", value: '{"marker":"PRIVATE_MARKER"}' }],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
}

test("native memory and SQL workspace spellings share identity without rewriting encrypted evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-workspace-codec-"))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  const id = MemoryPaths.identity({
    ctx: { directory: await realpath(workspace), worktree: await realpath(workspace) },
  })
  const directory = path.join(root, "memory", id.folder)
  await mkdir(path.join(directory, "sessions"), { recursive: true })
  await MemoryFiles.writeManifest(directory, id)
  await MemoryFiles.writeState(directory, MemorySchema.create())
  for (const name of ["project.md", "environment.md", "corrections.md"] as const)
    await writeFile(path.join(directory, name), "# Actual native memory café 日本語 😀\n")
  const memory = await memories(path.join(root, "memory"))
  const normalized = id.canonical.replaceAll("\\", "/")
  const source = payload.parse({
    ...value(),
    workspaces: [normalized],
    sql: [{ table: "session", columns: ["directory"], rows: [[normalized]] }],
    memory,
  })
  expect(source.memory[0].workspace).toBe(id.canonical)
  expect(
    (await unseal(await seal(source, "private memory spelling passphrase"), "private memory spelling passphrase"))
      .memory,
  ).toEqual(memory)
  expect(() => payload.parse({ ...source, workspaces: [normalized + "-unmapped"] })).toThrow()
  expect(() => payload.parse({ ...source, memory: [...memory, { ...memory[0], workspace: normalized }] })).toThrow()
  const windows = { ...memory[0], workspace: "C:\\Source\\workspace" }
  expect(
    payload.parse({ ...value(), workspaces: ["c:/source/workspace"], memory: [windows] }).memory[0].workspace,
  ).toBe(windows.workspace)
  expect(() =>
    payload.parse({
      ...value(),
      workspaces: ["c:/source/workspace"],
      memory: [windows, { ...windows, workspace: "c:/source/workspace" }],
    }),
  ).toThrow()
})

test("authenticated profile codec rejects wrong keys, tampering and unallowlisted authority data", async () => {
  const source = value()
  const first = await seal(source, "test private passphrase")
  const second = await seal(source, "test private passphrase")
  expect(first).not.toBe(second)
  expect(first).not.toContain("PRIVATE_MARKER")
  expect(await unseal(first, "test private passphrase")).toEqual(source)
  await assert.rejects(unseal(first, "different private passphrase"))
  const changed = JSON.parse(first)
  changed.tag = "0".repeat(32)
  await assert.rejects(unseal(JSON.stringify(changed), "test private passphrase"))
  expect(() => payload.parse({ ...source, json: [{ path: "../auth.json", value: "{}" }] })).toThrow()
  expect(() =>
    payload.parse({ ...source, sql: [{ table: "credential", columns: ["value"], rows: [["secret"]] }] }),
  ).toThrow()
  expect(() => payload.parse({ ...source, complete: true })).toThrow()
  expect(() =>
    payload.parse({ ...source, json: [{ path: "raya/goal/nested/../../auth.json", value: "{}" }] }),
  ).toThrow()
  expect(() => payload.parse({ ...source, json: [{ path: "raya/goal/device:alternate.json", value: "{}" }] })).toThrow()
  await assert.rejects(unseal(JSON.stringify({ ...JSON.parse(first), version: 2 }), "test private passphrase"))
  await assert.rejects(
    unseal(JSON.stringify({ ...JSON.parse(first), cipher: "aes-256-cbc" }), "test private passphrase"),
  )
})

test("incomplete or forged capture authority refuses before touching source paths", async () => {
  await assert.rejects(
    withCapture([], async () => "must not run"),
    /complete/,
  )
  await assert.rejects(
    exportProfile({ complete: true }, [], { database: "missing", storage: "missing" }, "test private passphrase"),
    /authority/,
  )
})

test("standalone memory namespace rejects traversal, source authority and credential-shaped content", () => {
  const source = value()
  const workspace = os.tmpdir()
  const memory = {
    workspace,
    state: JSON.stringify(MemorySchema.create()),
    sources: { "project.md": "# Facts", "environment.md": "# Environment", "corrections.md": "# Corrections" },
    sessions: [],
    decisions: "",
  }
  expect(payload.parse({ ...source, workspaces: [workspace], memory: [memory] }).memory).toHaveLength(1)
  expect(() => payload.parse({ ...source, memory: [memory] })).toThrow()
  expect(() =>
    payload.parse({
      ...source,
      workspaces: [workspace],
      memory: [{ ...memory, sessions: [{ name: "../outside.md", text: "escaped" }] }],
    }),
  ).toThrow()
  expect(() =>
    payload.parse({
      ...source,
      workspaces: [workspace],
      memory: [{ ...memory, sources: { ...memory.sources, "project.md": "password=hunterx" } }],
    }),
  ).toThrow()
  expect(() => payload.parse({ ...source, workspaces: [workspace], memory: [{ ...memory, portable: true }] })).toThrow()
})

test("archived evidence is bounded, nonrecursive and never supplies capture authority", async () => {
  const source = value()
  const { archives: _, ...base } = source
  const archive = snapshot.parse({ ...base, id: crypto.randomUUID() })
  const data = payload.parse({ ...source, archives: [archive] })
  expect((await unseal(await seal(data, "test private passphrase"), "test private passphrase")).archives).toEqual([
    archive,
  ])
  expect(() => payload.parse({ ...source, archives: [{ ...archive, archives: [] }] })).toThrow()
  expect(() => payload.parse({ ...source, archives: [{ ...archive, complete: true }] })).toThrow()
  expect(() => payload.parse({ ...source, archives: [archive, archive] })).toThrow()
  const authority = {
    ...archive,
    sql: [
      { table: "session", columns: ["permission", "share_url"], rows: [["source allow grant", "source share token"]] },
    ],
  }
  expect(payload.parse({ ...source, archives: [authority] }).archives[0].sql[0].rows).toEqual([[null, null]])
  expect(() =>
    payload.parse({ ...source, archives: Array.from({ length: 65 }, () => ({ ...archive, id: crypto.randomUUID() })) }),
  ).toThrow()
  await assert.rejects(
    exportProfile(data, [], { database: "missing", storage: "missing" }, "test private passphrase"),
    /authority/,
  )
})

test("oversized encrypted input refuses before parsing or allocating a destination", async () => {
  await assert.rejects(unseal("x".repeat(180 * 1024 * 1024 + 1), "test private passphrase"), /exceeds/)
})

test("real shipped SQL schema and persistent goal restore into a new held inactive profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-profile-bundle-"))
  await mkdir(path.join(root, "home"))
  const env = { ...process.env }
  for (const name of Object.keys(env))
    if (name.startsWith("OTEL_") || /(API_KEY|TOKEN|SECRET)$/.test(name)) delete env[name]
  Object.assign(env, {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    KILO_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    RAYA_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    LOCALAPPDATA: path.join(root, "local"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
  })
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/profile-bundle-restore.ts"), root], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const timer = setTimeout(() => child.kill(), 45_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  if (code !== 0) console.error(`Retained restore diagnostics ${root}: ${stderr}`)
  expect(code).toBe(0)
  const line = stdout.split("\n").find((line) => line.startsWith("BUNDLE_RESTORE_RECEIPT "))
  expect(JSON.parse(line!.slice("BUNDLE_RESTORE_RECEIPT ".length))).toMatchObject({
    passed: true,
    held: true,
    remapped: true,
    credentials: 0,
    portableAuthorityClaimed: false,
  })
  expect(() => process.kill(child.pid, 0)).toThrow()
}, 50_000)
