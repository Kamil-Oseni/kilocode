import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { payload, snapshot, seal, unseal } from "../../src/kilocode/migration/profile-bundle"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { boundData, collectSecondary, unionArchives } from "../../src/kilocode/migration/profile-secondary"
import { namespaceID, secondary } from "../../src/kilocode/migration/profile-secondary-schema"
import { select } from "../../src/kilocode/migration/profile-selection"
import { historical } from "../../src/kilocode/migration/profile-evidence"
import { identity } from "../../src/kilocode/migration/profile-workspaces"
import { GlobalScopes } from "@opencode-ai/core/kilocode/source-scopes"
import z from "zod"

function environment(root: string) {
  const home = path.join(root, "isolated-home")
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:RAYA|KILO|OPENCODE|OTEL)_/.test(name) && !/(?:API_KEY|TOKEN|SECRET)$/.test(name),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    KILO_TEST_HOME: home,
    LOCALAPPDATA: path.join(root, "local"),
    XDG_DATA_HOME: path.join(root, "runtime-data"),
    XDG_CONFIG_HOME: path.join(root, "runtime-config"),
    XDG_CACHE_HOME: path.join(root, "runtime-cache"),
    XDG_STATE_HOME: path.join(root, "runtime-state"),
    RAYA_DB: path.join(root, "unused.db"),
    KILO_DB: path.join(root, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
  }
}

function record() {
  return snapshot.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: 1,
    schema: "a".repeat(64),
    workspaces: [],
    sql: [],
    json: [],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
}

test("historical union deduplicates equal UUIDs and refuses divergent evidence", () => {
  const source = record()
  expect(unionArchives([[source], [snapshot.parse(source)]])).toEqual([source])
  expect(() => unionArchives([[source], [{ ...source, createdAt: 2 }]])).toThrow("conflicting content")
  expect(() => unionArchives([Array.from({ length: 65 }, record)])).toThrow("shared bound")
})

test("secondary schema rejects altered provenance, active flags and dangling archive references", () => {
  const data = path.resolve("synthetic-secondary")
  const storage = path.join(data, "storage")
  const source = record()
  const evidence = {
    format: "raya.secondary-data" as const,
    version: 1 as const,
    namespaces: [{ id: namespaceID(data, storage), source: { data, storage }, memory: [], archives: [source.id] }],
    reviewOnly: true as const,
    activation: "held" as const,
    coverage: "declared-secondary-data" as const,
    completeProfileCoverage: false as const,
    portableCaptureAuthorized: false as const,
  }
  expect(secondary.parse(evidence).namespaces).toHaveLength(1)
  expect(() => secondary.parse({ ...evidence, portableCaptureAuthorized: true })).toThrow()
  expect(() =>
    secondary.parse({ ...evidence, namespaces: [{ ...evidence.namespaces[0], id: "0".repeat(64) }] }),
  ).toThrow()
  expect(() => payload.parse({ ...source, secondary: evidence, archives: [] })).toThrow("historical snapshot")
  expect(payload.parse({ ...record(), secondary: evidence, archives: [source] }).archives).toHaveLength(1)
})

test("bundle applies one Git inventory limit across independently valid namespaces", () => {
  const data = path.resolve("synthetic-secondary")
  const storage = path.join(data, "storage")
  const git = (source: string) => ({
    version: 1 as const,
    snapshots: [],
    worktrees: [],
    repositories: [
      {
        id: createHash("sha256").update(identity(source)).digest("hex"),
        source,
        files: [],
        directories: Array.from({ length: 10_001 }, (_, index) => `dir-${index}`),
        alternates: [],
        objectFormat: "sha1" as const,
      },
    ],
  })
  const secondary = {
    format: "raya.secondary-data" as const,
    version: 1 as const,
    namespaces: [
      { id: namespaceID(data, storage), source: { data, storage }, memory: [], archives: [], artifacts: git(data) },
    ],
    reviewOnly: true as const,
    activation: "held" as const,
    coverage: "declared-secondary-data" as const,
    completeProfileCoverage: false as const,
    portableCaptureAuthorized: false as const,
  }
  expect(payload.parse({ ...record(), secondary }).secondary?.namespaces).toHaveLength(1)
  expect(() => payload.parse({ ...record(), artifacts: git(path.resolve("synthetic-primary")), secondary })).toThrow(
    "shared namespace",
  )
})

test.skipIf(process.platform !== "win32")(
  "held independent Global data retains separate Unicode memories, Git snapshots and equal archives through encryption",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-secondary-data-")))
    const primary = path.join(root, "primary")
    const data = [path.join(root, "graph-one"), path.join(root, "graph-two")]
    const workspace = path.join(root, "workspace")
    await Promise.all([
      mkdir(path.join(primary, "storage"), { recursive: true }),
      mkdir(workspace),
      ...data.map((dir) => mkdir(path.join(dir, "storage"), { recursive: true })),
    ])
    const database = path.join(primary, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('read-only image')")
    db.close()
    const source = record()
    const memory = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
    }
    for (const [index, directory] of data.entries()) {
      const dir = path.join(directory, "memory", memory.folder)
      await mkdir(path.join(dir, "sessions"), { recursive: true })
      await MemoryFiles.writeManifest(dir, memory)
      await MemoryFiles.writeState(dir, MemorySchema.create())
      for (const name of ["project.md", "environment.md", "corrections.md"])
        await writeFile(path.join(dir, name), `# Graph ${index} café 日本語 😀\n`)
      await writeFile(path.join(dir, "sessions", "actual.md"), `Session graph ${index} 日本語 😀\n`)
      await writeFile(path.join(directory, "restore-source.json"), JSON.stringify(payload.parse(source)))
      const repo = path.join(
        directory,
        "snapshot",
        `project-${index}`,
        createHash("sha1").update(workspace).digest("hex"),
      )
      await mkdir(path.dirname(repo), { recursive: true })
      const child = Bun.spawn(["git", "init", "--bare", repo], {
        env,
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, stderr)
      await writeFile(path.join(repo, "refs", "graph.txt"), `Graph ${index} café 日本語 😀`)
    }
    const originals = await Promise.all(data.map((dir) => readFile(path.join(dir, "restore-source.json"))))
    const policy = { version: 1 as const, directories: [primary, ...data, workspace].sort(), files: [] }
    const selection = await select({ database, storage: path.join(primary, "storage") }, policy)
    const roles = (dir: string) => ({
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
    })
    await mkdir(environment(root).HOME)
    const graph = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-secondary-globals.ts"), root, ...data],
      {
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const stopped = { forced: false }
    const cutoff = setTimeout(() => {
      stopped.forced = true
      graph.kill()
    }, 15_000)
    const [status, , error] = await Promise.all([
      graph.exited,
      new Response(graph.stdout).text(),
      new Response(graph.stderr).text(),
    ])
    clearTimeout(cutoff)
    assert.equal(stopped.forced, false)
    assert.equal(status, 0, error)
    assert.throws(() => process.kill(graph.pid, 0))
    const globals = z
      .array(GlobalScopes)
      .parse(JSON.parse(await readFile(path.join(root, "secondary-globals.json"), "utf8")))
    const selected = {
      ...selection,
      roots: [
        ...selection.roots,
        ...[...new Set(globals.flatMap((item) => Object.values(item)))].map((dir) => ({
          kind: "json" as const,
          path: dir,
        })),
        { kind: "json" as const, path: workspace },
      ],
      globals: [roles(primary), ...globals, globals[0]],
    }
    const bin = path.join(root, "private-helper")
    await mkdir(bin)
    const executable = path.join(bin, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), executable)
    const digest = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
    let token: Working | undefined
    await withImage(
      { roots: selected.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
      async (image) => {
        await withWorking(image, selected, async (working) => {
          token = working
          const collected = await collectSecondary(working, primary, [workspace], undefined, [])
          expect(collected.secondary?.namespaces).toHaveLength(2)
          expect(collected.archives).toHaveLength(1)
          expect(collected.secondary?.namespaces.map((item) => item.memory[0].sessions[0].text)).toEqual([
            "Session graph 0 日本語 😀\n",
            "Session graph 1 日本語 😀\n",
          ])
          expect(collected.secondary?.namespaces.map((item) => item.artifacts?.snapshots[0].project)).toEqual([
            "project-0",
            "project-1",
          ])
          const checked = payload.parse({ ...record(), workspaces: [workspace], ...collected })
          const opened = await unseal(
            await seal(checked, "private secondary evidence passphrase"),
            "private secondary evidence passphrase",
          )
          expect(opened.secondary).toEqual(checked.secondary)
          await writeFile(path.join(root, "secondary-input.json"), JSON.stringify(opened))
          const inert = path.join(root, "inactive-review")
          await mkdir(inert)
          await writeFile(path.join(inert, "restore-source.json"), JSON.stringify(opened))
          const history = await historical(inert)
          expect(history).toHaveLength(2)
          expect(history[1].secondary).toEqual(checked.secondary)
          await assert.rejects(collectSecondary(working, primary, [], undefined, []), /workspace mapping/)
          await assert.rejects(boundData(working, primary), /private image namespace/)
          await assert.rejects(collectSecondary(working, workspace, [workspace], undefined, []), /differs/)
          expect(() => payload.parse({ ...checked, workspaces: [] })).toThrow("undeclared")
        })
      },
    )
    await assert.rejects(collectSecondary(token!, primary, [workspace], undefined, []), /expired/)
    for (const [index, directory] of data.entries())
      expect(await readFile(path.join(directory, "restore-source.json"))).toEqual(originals[index])
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/profile-secondary-restore.ts"), root],
      {
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const deadline = { forced: false }
    const timer = setTimeout(() => {
      deadline.forced = true
      child.kill()
    }, 45_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "restore-stdout.log"), stdout)
    await writeFile(path.join(root, "restore-stderr.log"), stderr)
    assert.equal(deadline.forced, false, `Private secondary restore timed out: ${root}`)
    assert.equal(code, 0, `Private secondary restore failed: ${root}: ${stderr}`)
    assert.throws(() => process.kill(child.pid, 0))
    expect(JSON.parse(await readFile(path.join(root, "secondary-restore-receipt.json"), "utf8"))).toMatchObject({
      ok: true,
      held: true,
      inactive: true,
      namespaces: 2,
      historical: 2,
      modelCalls: 0,
    })
  },
  60_000,
)
