import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile, readdir } from "node:fs/promises"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { Hash } from "@opencode-ai/core/util/hash"
import { payload, seal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { collect, discover } from "../../../src/kilocode/migration/profile-artifacts"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { Server } from "../../../src/server/server"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root)
if (process.argv[3] === "read") {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const response = await fetch(new URL("/session/ses_checkpointfixture/checkpoint", listener.url), {
      headers: { "x-kilo-directory": path.join(root, "mapped") },
    })
    assert.equal(response.status, 200, await response.clone().text())
    const rows = await response.json()
    const source = JSON.parse(await readFile(path.join(root, "checkpoint.json"), "utf8"))
    assert.deepEqual(rows, [source])
    console.log("CHECKPOINT_API_READ_OK")
  } catch (err) {
    process.exitCode = 1
    console.error(err)
  } finally {
    await listener.stop(true)
    await finish([])
  }
} else {
  const source = path.join(root, "source")
  const storage = path.join(source, "storage")
  const workspace = path.join(root, "workspace")
  const mapped = path.join(root, "mapped")
  await Promise.all([mkdir(storage, { recursive: true }), mkdir(workspace), mkdir(mapped)])
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-config") }
  const git = async (...args: string[]) => {
    const index = args.indexOf("--git-dir")
    const cwd = index === -1 ? workspace : args[index + 1]
    const input = [...args]
    if (index !== -1) input[index + 1] = "."
    const child = Bun.spawn(["git", "-c", "core.longpaths=true", ...input], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    assert.equal(code, 0, error)
    return text.trim()
  }
  await git("init")
  await writeFile(path.join(workspace, "named.txt"), "Named checkpoint café 日本語 😀\n")
  await git("add", "named.txt")
  const snapshot = path.join(source, "snapshot", "project", Hash.fast(workspace))
  await mkdir(snapshot, { recursive: true })
  await git("init", "--bare", snapshot)
  await git("--git-dir", snapshot, "--work-tree", workspace, "add", ".")
  const checkpoint = {
    id: crypto.randomUUID(),
    name: "Named checkpoint café 日本語 😀",
    hash: await git("--git-dir", snapshot, "write-tree"),
    createdAt: 1000,
  }
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "--git-dir",
    snapshot,
    "--work-tree",
    workspace,
    "commit",
    "-m",
    "private checkpoint",
  )
  await git("--git-dir", snapshot, "repack", "-ad")
  const packs = await readdir(path.join(snapshot, "objects", "pack"))
  assert.ok(packs.some((name) => name.endsWith(".pack")))
  assert.ok(packs.some((name) => name.endsWith(".idx")))
  await writeFile(path.join(root, "checkpoint.json"), JSON.stringify(checkpoint))
  const database = path.join(source, "raya.db")
  const runtime = ManagedRuntime.make(Database.layerFromPath(database))
  const schema = await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        `INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('project','${workspace.replaceAll("'", "''")}',1,1,'[]')`,
      )
      yield* db.run(
        `INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_checkpointfixture','project','checkpoint','${path.join(workspace, "nested").replaceAll("'", "''")}', 'Named checkpoint fixture','1',1,1)`,
      )
      return yield* signature((query) => db.all<Column>(query))
    }),
  )
  await runtime.dispose()
  const db = new Native(database, { readonly: true })
  const sql = tables.map((table) => ({
    table,
    columns: db
      .query<Column, []>(`PRAGMA table_info('${table}')`)
      .all()
      .map((column) => column.name),
    rows: db.query(`SELECT * FROM "${table}"`).values(),
  }))
  db.close()
  const policy = { version: 1 as const, directories: [source, workspace], files: [] }
  const selected = await select({ database, storage }, policy)
  const roots = await discover({ data: source, workspaces: [workspace] })
  const executable = await realpath(
    path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"),
  )
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex")
  const selection = {
    ...selected,
    roots: [...selected.roots, ...roots.filter((item) => !item.path.startsWith(source + path.sep))],
  }
  await withImage(
    {
      roots: selection.roots,
      policy,
      helper: { executable, digest },
      registry: path.join(root, "registry"),
    },
    async (image) => {
      await withWorking(image, selection, async (working) => {
        const artifacts = await collect(working, { data: source, workspaces: [workspace] })
        const value = payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: crypto.randomUUID(),
          createdAt: 1000,
          schema,
          workspaces: [workspace],
          sql,
          artifacts,
          json: [{ path: "raya/checkpoint/ses_checkpointfixture.json", value: JSON.stringify([checkpoint]) }],
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        })
        assert.equal(payload.safeParse({ ...value, artifacts: undefined }).success, false)
        assert.equal(
          payload.safeParse({
            ...value,
            json: [{ path: "raya/checkpoint/unknown.json", value: JSON.stringify([checkpoint]) }],
          }).success,
          false,
        )
        assert.equal(
          payload.safeParse({
            ...value,
            json: [
              {
                path: "raya/checkpoint/ses_checkpointfixture.json",
                value: JSON.stringify([{ ...checkpoint, command: "forbidden" }]),
              },
            ],
          }).success,
          false,
        )
        const unavailable = {
          ...value,
          json: [
            {
              path: "raya/checkpoint/ses_checkpointfixture.json",
              value: JSON.stringify([{ ...checkpoint, hash: "0".repeat(40) }]),
            },
          ],
        }
        const rejected = path.join(root, "rejected")
        await assert.rejects(
          restore(
            await seal(unavailable, "private checkpoint fixture passphrase"),
            "private checkpoint fixture passphrase",
            rejected,
            { [workspace]: mapped },
          ),
          /checkpoint tree is unavailable/,
        )
        assert.equal(await Bun.file(path.join(rejected, "data", "kilo", "raya.db")).exists(), false)
        const parent = path.join(root, "migration-" + "d".repeat(75))
        await mkdir(parent)
        const restored = await restore(
          await seal(value, "private checkpoint fixture passphrase"),
          "private checkpoint fixture passphrase",
          path.join(parent, "destination"),
          { [workspace]: mapped },
        )
        const target = path.join(restored.path, "snapshot", "project", Hash.fast(mapped))
        for (const name of packs) {
          const copied = path.join(target, "objects", "pack", name)
          assert.ok(copied.length > 260)
          assert.deepEqual(await readFile(copied), await readFile(path.join(snapshot, "objects", "pack", name)))
        }
        assert.equal(restored.reviewed, false)
        assert.equal(restored.uncertainWork, "held-no-replay")
        assert.equal(await git("--git-dir", target, "cat-file", "-t", checkpoint.hash), "tree")
        assert.equal(
          await git("--git-dir", target, "show", `${checkpoint.hash}:named.txt`),
          "Named checkpoint café 日本語 😀",
        )
        const child = Bun.spawn([process.execPath, import.meta.filename, root, "read"], {
          env: { ...process.env, ...restored.env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        const timeout = setTimeout(() => child.kill(), 30_000)
        const [code, text, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        clearTimeout(timeout)
        assert.equal(code, 0, error)
        assert.ok(text.includes("CHECKPOINT_API_READ_OK"))
        assert.throws(() => process.kill(child.pid, 0))
        console.log("CHECKPOINT_LONG_PACK_OK")
      })
    },
  )
  console.log("CHECKPOINT_RESTORE_OK")
  await finish([])
}
