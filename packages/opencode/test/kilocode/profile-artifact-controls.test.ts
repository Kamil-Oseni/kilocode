import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import { acquireProfileRoot, registerProfileFile } from "@opencode-ai/core/kilocode/profile-maintenance"
import { tmpdir } from "../fixture/fixture"
import { artifacts, attach, materialize, type Artifacts } from "../../src/kilocode/migration/profile-artifacts"
import { controls } from "../../src/kilocode/migration/profile-artifact-controls"
import { identity } from "../../src/kilocode/migration/profile-workspaces"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const entry = (file: string, bytes: Buffer) => ({
  path: file,
  bytes: bytes.toString("base64"),
  digest: hash(bytes),
  mode: 0o600,
})

test("real coordination records stay inert in primary evidence and refuse every direct destination before writes", async () => {
  await using tmp = await tmpdir({ git: true })
  const primary = tmp.path
  const source = path.join(primary, ".git")
  const state = path.join(primary, "coordination", "state.json")
  await mkdir(path.dirname(state))
  await writeFile(state, "actual owned state")
  const lease = await acquireProfileRoot({ kind: "json", path: state })
  const owner = registerProfileFile({ kind: "json", path: state })
  const directory = path.join(path.dirname(state), ".raya-profile-locks")
  try {
    const records = (
      await Promise.all(
        (await readdir(directory, { recursive: true })).map(async (name) => {
          const file = path.join(directory, name)
          const info = await lstat(file, { bigint: true })
          if (!info.isFile()) return undefined
          assert(!info.isSymbolicLink() && info.nlink === 1n)
          return { file, dev: info.dev, ino: info.ino, bytes: await readFile(file) }
        }),
      )
    ).filter((item) => item !== undefined)
    assert(records.some((item) => path.dirname(item.file).endsWith(".writers")))
    assert(records.some((item) => item.bytes.toString().includes("raya.profile-native-owner")))
    const files = records.map((item) => entry(path.relative(primary, item.file).split(path.sep).join("/"), item.bytes))
    const id = hash(identity(source))
    const workspace = path.join(primary, "managed-original")
    const value: Artifacts = artifacts.parse({
      version: 1,
      repositories: [
        {
          id,
          source,
          workspace: primary,
          objectFormat: "sha1",
          alternates: [],
          directories: [],
          files: [entry("HEAD", await readFile(path.join(source, "HEAD")))],
          working: { files, directories: [], excluded: [] },
        },
      ],
      snapshots: [],
      worktrees: [
        {
          project: "project",
          name: "one",
          workspace,
          common: id,
          files: [],
          directories: [],
          admin: [],
          adminDirectories: [],
        },
      ],
    })
    const stage = path.join(primary, "inert-stage")
    const destination = path.join(primary, "destination")
    const mapped = path.join(destination, "worktree", "project", "one")
    const mappings = new Map([
      [workspace, mapped],
      [primary, path.join(primary, "new-primary")],
    ])
    assert.equal(controls(value), false)
    await materialize(value, stage, destination, mappings)
    for (const file of files)
      assert.deepEqual(
        await readFile(path.join(stage, "git-artifacts", "primary-evidence", id, "tree", file.path)),
        Buffer.from(file.bytes, "base64"),
      )
    await assert.rejects(
      lstat(path.join(stage, "worktree", "project", "one", "coordination", ".raya-profile-locks")),
      /ENOENT/,
    )
    const cases: ((input: Artifacts) => void)[] = [
      (input) => {
        input.repositories[0].files.push(files[0])
      },
      (input) => {
        input.repositories[0].directories.push("nested/.RAYA-PROFILE-LOCKS")
      },
      (input) => {
        input.worktrees[0].files.push(files[0])
      },
      (input) => {
        input.worktrees[0].directories.push("nested/.raya-profile-locks")
      },
      (input) => {
        input.worktrees[0].admin.push(files[0])
      },
      (input) => {
        input.worktrees[0].adminDirectories.push("nested/.Raya-Profile-Locks/owner")
      },
      (input) => {
        input.worktrees[0].project = ".raya-profile-locks"
      },
      (input) => {
        input.worktrees[0].name = ".RAYA-PROFILE-LOCKS"
      },
      (input) => {
        input.snapshots.push({ project: "nested/.raya-profile-locks", workspace: primary, repository: id })
      },
    ]
    for (const [index, change] of cases.entries()) {
      const input = structuredClone(value)
      change(input)
      assert.equal(artifacts.safeParse(input).success, false)
      const target = path.join(primary, "refused-" + index)
      await assert.rejects(
        materialize(input, target, target, mappings),
        /Unsupported active profile coordination artifact/,
      )
      await assert.rejects(
        attach(input, target, mappings, [primary]),
        /Unsupported active profile coordination artifact/,
      )
      await assert.rejects(lstat(target), /ENOENT/)
    }
    for (const record of records) {
      const info = await lstat(record.file, { bigint: true })
      assert.equal(info.dev, record.dev)
      assert.equal(info.ino, record.ino)
      assert.deepEqual(await readFile(record.file), record.bytes)
    }
    expect(records.length).toBeGreaterThanOrEqual(2)
  } finally {
    owner.release()
    await lease.release()
  }
}, 30000)

test("legacy ordinary and similarly named components materialize without changing their bytes", async () => {
  await using tmp = await tmpdir({ git: true })
  const source = path.join(tmp.path, ".git")
  const id = hash(identity(source))
  const workspace = path.join(tmp.path, "original-worktree")
  const files = [
    entry(".raya-profile-locks-user/keep.txt", Buffer.from("ordinary user bytes")),
    entry("nested/.raya-profile-locks.txt", Buffer.from("ordinary named file")),
  ]
  const value = artifacts.parse({
    version: 1,
    repositories: [
      {
        id,
        source,
        files: [entry("HEAD", await readFile(path.join(source, "HEAD")))],
        directories: [],
        alternates: [],
        objectFormat: "sha1",
      },
    ],
    snapshots: [],
    worktrees: [
      {
        project: "project",
        name: "one",
        workspace,
        common: id,
        files,
        directories: ["empty"],
        admin: [],
        adminDirectories: [],
      },
    ],
  })
  const stage = path.join(tmp.path, "stage")
  const destination = path.join(tmp.path, "destination")
  await materialize(
    value,
    stage,
    destination,
    new Map([[workspace, path.join(destination, "worktree", "project", "one")]]),
  )
  for (const file of files)
    assert.deepEqual(
      await readFile(path.join(stage, "worktree", "project", "one", file.path)),
      Buffer.from(file.bytes, "base64"),
    )
  expect((await lstat(path.join(stage, "worktree", "project", "one", "empty"))).isDirectory()).toBe(true)
  const input = structuredClone(value)
  input.worktrees[0].files.push(entry("nested\\.RAYA-PROFILE-LOCKS\\meta.json", Buffer.from("invalid direct caller")))
  assert.equal(controls(input), true)
  await assert.rejects(
    materialize(input, path.join(tmp.path, "invalid"), destination, new Map()),
    /Unsupported active profile coordination artifact/,
  )
})
