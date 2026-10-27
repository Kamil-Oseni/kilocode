import { afterAll, afterEach, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, realpath, readFile, writeFile, symlink } from "node:fs/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer, ManagedRuntime, Exit } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import * as TaskFiles from "@/kilocode/tool/task-files"
import * as Files from "@/kilocode/task/output-scope"
import { payload, seal, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { inspect, project } from "@/kilocode/migration/profile-task-files-restore"
import { remap } from "@/kilocode/migration/profile-workspaces"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove } from "./cleanup"

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-task-transfer-")))
const db = path.join(root, "source.sqlite")
const storage = path.join(root, "storage")
const graph = (db: string, storage: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Session.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      InstanceStore.node,
      EventV2Bridge.node,
    ]),
    [
      [Database.node, Database.layerFromPath(db)],
      [
        Storage.node,
        LayerNode.make({
          service: Storage.Service,
          layer: Storage.layerWithDatabase(storage),
          deps: [FSUtil.node, Git.node, Database.node],
        }),
      ],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  )
const it = testEffect(graph(db, storage))
afterEach(disposeAllInstances)
afterAll(async () => {
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(remove))
}, 30_000)

it.instance(
  "encrypted Task scope restore keeps exact same-path and remapped ceilings without granting authority",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const sessions = yield* Session.Service
      const store = yield* Storage.Service
      const database = yield* Database.Service
      const filename = process.platform === "win32" ? "Owned.txt" : "owned.txt"
      yield* fs.writeFileString(path.join(instance.directory, filename), "Preserve existing file bytes")
      const parent = yield* sessions.create({ title: "Original owner" })
      const child = yield* sessions.create({ title: "Scoped worker", parentID: parent.id })
      const binding = yield* TaskFiles.bind({
        session: child.id,
        parent: parent.id,
        directory: instance.directory,
        files: ["owned.txt"],
        storage: store,
        fs,
      })
      yield* sessions.setMetadata({ sessionID: child.id, metadata: { [TaskFiles.key]: binding, untouched: "saved" } })
      const name = `raya/task-files/${createHash("sha256").update(child.id).digest("hex")}.json`
      const original = yield* Effect.promise(() => readFile(path.join(storage, ...name.split("/")), "utf8"))
      const sql = yield* Effect.forEach(tables, (table) =>
        Effect.gen(function* () {
          const columns = yield* database.db.all<Column>(`PRAGMA table_info('${table}')`)
          const rows = yield* database.db.all<Record<string, string | number | null>>(`SELECT * FROM "${table}"`)
          return {
            table,
            columns: columns.map((column) => column.name),
            rows: rows.map((row) => columns.map((column) => row[column.name])),
          }
        }),
      )
      const source = payload.parse({
        format: "raya.profile-data",
        version: 1,
        id: crypto.randomUUID(),
        createdAt: 100,
        schema: yield* signature((query) => database.db.all<Column>(query)),
        workspaces: [instance.directory],
        sql,
        json: [{ path: name, value: original }],
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      const encrypted = yield* Effect.promise(() => seal(source, "private fixture passphrase"))
      expect(encrypted).not.toContain(child.id)
      const mapped = yield* Effect.promise(async () => {
        const dir = path.join(root, "mapped")
        await mkdir(dir)
        await writeFile(path.join(dir, filename), "Preserve existing file bytes")
        return await realpath(dir)
      })
      for (const [index, directory] of [instance.directory, mapped].entries()) {
        const destination = yield* Effect.promise(() =>
          restore(encrypted, "private fixture passphrase", path.join(root, `restored-${index}`), {
            [instance.directory]: directory,
          }),
        )
        expect(destination.reviewed).toBe(false)
        expect(destination.uncertainWork).toBe("held-no-replay")
        const retained = yield* Effect.promise(() =>
          readFile(path.join(destination.path, "restore-source.json"), "utf8"),
        )
        expect(JSON.parse(retained).json[0].value).toBe(original)
        expect(createHash("sha256").update(JSON.parse(retained).json[0].value).digest("hex")).toBe(
          createHash("sha256").update(original).digest("hex"),
        )
        const runtime = ManagedRuntime.make(
          graph(path.join(destination.path, "raya.db"), path.join(destination.path, "storage")),
        )
        try {
          yield* Effect.promise(() =>
            runtime.runPromise(
              InstanceStore.Service.use((instances) =>
                instances.provide(
                  { directory },
                  Effect.gen(function* () {
                    const sessions = yield* Session.Service
                    const selected = yield* Database.Service
                    const fs = yield* FSUtil.Service
                    const canonical = yield* Files.canonical(fs, [path.join(directory, "owned.txt")])
                    const restored = yield* sessions.get(child.id)
                    const saved = TaskFiles.read(restored.metadata)
                    if (!saved) throw new Error("The restored child must retain its Task file scope")
                    expect(saved).toEqual({ ...binding, directory, canonical })
                    expect(restored.metadata?.untouched).toBe("saved")
                    expect(restored.permission).toBeUndefined()
                    expect(yield* TaskFiles.check(restored, [path.join(directory, "owned.txt")])).toEqual(
                      saved.canonical,
                    )
                    expect(
                      Exit.isFailure(
                        yield* TaskFiles.check(restored, [path.join(directory, "foreign.txt")]).pipe(Effect.exit),
                      ),
                    ).toBe(true)
                    expect(TaskFiles.permits(restored.metadata, "bash")).toBe(false)
                    expect(yield* inspect(destination.path, selected)).toEqual([saved])
                    const next = yield* sessions.create({ title: "Unrelated later worker", parentID: parent.id })
                    const store = yield* Storage.Service
                    const newer = yield* TaskFiles.bind({
                      session: next.id,
                      parent: parent.id,
                      directory,
                      files: [],
                      storage: store,
                      fs,
                    })
                    yield* sessions.setMetadata({ sessionID: next.id, metadata: { [TaskFiles.key]: newer } })
                    expect(yield* inspect(destination.path, selected)).toEqual([saved])
                  }),
                ),
              ),
            ),
          )
        } finally {
          yield* Effect.promise(() => runtime.dispose())
        }
      }
      expect(yield* Effect.promise(() => readFile(path.join(storage, ...name.split("/")), "utf8"))).toBe(original)
      expect((yield* sessions.get(child.id)).metadata?.[TaskFiles.key]).toEqual(binding)
      const reserved = path.join(root, "managed-profile", "data")
      const stage = path.join(root, "managed-profile", ".pending")
      const destination = path.join(reserved, "kilo")
      const directory = path.join(destination, "worktree", "project", "worker")
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(reserved, { recursive: true }),
          mkdir(path.join(stage, "worktree", "project", "worker"), { recursive: true }),
        ]),
      )
      const mapping = new Map([[instance.directory, directory]])
      const target = { json: source.json, sql: remap(source.sql, mapping) }
      const projected = yield* project({ source, target, mapping, stage, destination })
      expect(JSON.parse(projected.json[0].value).canonical).toEqual([path.join(directory, "owned.txt")])
      const external = path.join(root, "outside")
      yield* Effect.promise(() => mkdir(external))
      yield* Effect.promise(() =>
        symlink(
          external,
          path.join(stage, "worktree", "project", "worker", "owned.txt"),
          process.platform === "win32" ? "junction" : "dir",
        ),
      )
      expect(Exit.isFailure(yield* project({ source, target, mapping, stage, destination }).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  60_000,
)
