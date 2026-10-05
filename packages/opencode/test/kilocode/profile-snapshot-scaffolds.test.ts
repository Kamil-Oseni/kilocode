import assert from "node:assert/strict"
import { test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { artifacts, collect, discover, materialize } from "../../src/kilocode/migration/profile-artifacts"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { bind, inspect, scaffold } from "../../src/kilocode/migration/profile-snapshot-scaffolds"
import { select } from "../../src/kilocode/migration/profile-selection"
import { identity } from "../../src/kilocode/migration/profile-workspaces"

test.skipIf(process.platform !== "win32")(
  "actual empty Snapshot lease residue retains native identities and stays inert",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-snapshot-scaffolds-")))
    const data = path.join(root, "data")
    const storage = path.join(data, "storage")
    const workspace = path.join(root, "workspace")
    await Promise.all([mkdir(storage, { recursive: true }), mkdir(workspace)])
    const database = path.join(root, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const namespace = path.join(data, "snapshot", "project", createHash("sha1").update(workspace).digest("hex"))
    await mkdir(namespace, { recursive: true })
    const git = Bun.spawn(["git", "init", "--bare", namespace], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [code, , stderr] = await Promise.all([
      git.exited,
      new Response(git.stdout).text(),
      new Response(git.stderr).text(),
    ])
    assert.equal(code, 0, stderr)
    const lease = await acquireProfileRoot({ kind: "json", path: path.dirname(namespace) })
    const child = await acquireCoveredProfileRoot(await resolveProfileRoot({ kind: "json", path: namespace }), lease)
    await child.release()
    await lease.release()
    const source = path.join(path.dirname(namespace), ".raya-profile-locks")
    const original = await inspect(source)
    const ancestor = await inspect(path.join(data, "snapshot", ".raya-profile-locks"))
    assert(original.children.some((item) => item.name === "covered.references"))
    const roots = await discover({ data, workspaces: [workspace] })
    assert(roots.some((item) => item.path === namespace))
    const configured = process.env.RAYA_TEST_DIRECTORY_HELPER
    const expected = process.env.RAYA_TEST_DIRECTORY_HELPER_SHA
    if (expected) assert(configured)
    const helper = await realpath(configured ?? (await NativeProcess.source()))
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    if (expected) assert.equal(digest, expected)
    const executable = path.join(root, "raya-process-host.exe")
    await copyFile(helper, executable)
    const policy = { version: 1 as const, directories: [root], files: [] }
    const base = await select({ database, storage, data }, policy)
    const selected = { ...base, roots: [...base.roots, { kind: "json" as const, path: workspace }] }
    const registry = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-scaffold-registry-")))
    const target = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-scaffold-restored-")))
    let expired: Working | undefined
    await withImage(
      {
        roots: selected.roots,
        policy,
        helper: { executable, digest },
        registry,
        inventory: "directories",
      },
      (image) =>
        withWorking(image, selected, async (working) => {
          expired = working
          const value = await collect(working, { data, workspaces: [workspace] })
          assert.deepEqual(value.snapshotScaffolds, [ancestor, original])
          const tampered = structuredClone(value)
          tampered.snapshotScaffolds![0].children.push(tampered.snapshotScaffolds![0].children[0])
          assert.equal(artifacts.safeParse(tampered).success, false)
          const stage = path.join(target, "restored")
          await materialize(
            value,
            stage,
            path.join(target, "destination"),
            new Map([[workspace, path.join(target, "workspace")]]),
          )
          const evidence = path.join(
            stage,
            "git-artifacts",
            "snapshot-scaffold-evidence",
            createHash("sha256").update(identity(source)).digest("hex"),
          )
          assert((await stat(evidence)).isDirectory())
          const copy = artifacts.parse(JSON.parse(JSON.stringify(value)))
          assert.deepEqual(copy.snapshotScaffolds, value.snapshotScaffolds)
          await materialize(
            copy,
            path.join(target, "restored-again"),
            path.join(target, "destination-again"),
            new Map([[workspace, path.join(target, "workspace-again")]]),
          )
          await assert.rejects(bind(Object.freeze({}) as Working, source, source), /unavailable/)
        }),
    )
    assert(expired)
    assert.deepEqual(await inspect(source), original)
    await assert.rejects(bind(expired, source, source), /expired/)
    await writeFile(path.join(source, "covered.references", "foreign.json"), "unsupported active record")
    await assert.rejects(discover({ data, workspaces: [] }), /nonempty/)
  },
  30000,
)

test("Snapshot scaffolds reject unknown, active and aliased directory shapes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-scaffold-negative-")))
  const source = path.join(root, ".raya-profile-locks")
  await mkdir(source)
  assert.deepEqual((await inspect(source)).children, [])
  await mkdir(path.join(source, "unknown"))
  await assert.rejects(inspect(source))
  const active = path.join(root, "active", ".raya-profile-locks", "covered.references")
  await mkdir(active, { recursive: true })
  await writeFile(path.join(active, "retained.json"), "real unsupported record")
  await assert.rejects(inspect(path.dirname(active)), /nonempty/)
  const alias = path.join(root, "alias", ".raya-profile-locks")
  await mkdir(path.dirname(alias))
  await symlink(source, alias, process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(inspect(alias), /aliased/)
})

test("malformed native scaffold identities refuse without parser defects", () => {
  const value = { source: path.resolve(".raya-profile-locks"), dev: "1", ino: "2", children: [], activation: "inert" }
  for (const field of ["dev", "ino"])
    for (const invalid of ["1.5", "", "-1", "18446744073709551616", "100000000000000000000"])
      assert.equal(scaffold.safeParse({ ...value, [field]: invalid }).success, false)
  assert.equal(scaffold.safeParse(value).success, true)
})
