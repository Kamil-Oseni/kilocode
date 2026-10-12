import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { RayaTask } from "@/kilocode/task"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Storage.layerFromDir(path.join(directory, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(directory, "history.sqlite"))),
  )
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

it.live(
  "legacy report histories over 500 cards bootstrap across restart and retain every paged result",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const source: Session.Info = {
        id: SessionID.make("ses_history"),
        slug: "history",
        title: "History",
        directory,
        projectID: ProjectV2.ID.make("global"),
        version: "1",
        time: { created: 1, updated: 1 },
      }
      const other = { ...source, id: SessionID.make("ses_other") }
      const sessions = { get: (id: SessionID) => Effect.succeed(id === source.id ? source : other) }
      const first = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const fs = yield* FSUtil.Service
        for (let count = 0; count < 510; count++) {
          const id = `legacy-${count}`
          const card: RayaRoutineReports.Card = {
            version: 1,
            id,
            agentID: "worker",
            name: "Worker",
            reportSessionID: count % 2 ? other.id : source.id,
            projectID: source.projectID,
            directory,
            revision: 1,
            status: "complete",
            at: count,
            summary: count % 2 ? "Result" : "界".repeat(8000),
            delivery: "delivered",
          }
          // Seed retained legacy files directly; the actual index/bootstrap and
          // subsequent publications still use the selected physical Storage.
          yield* fs.writeWithDirs(
            path.join(directory, "storage", "raya", "routine-reports", `${hash(id)}.json`),
            JSON.stringify(card),
          )
        }
        const reports = RayaRoutineReports.make({ storage, sessions, scope: source })
        const page = yield* reports.page({ sessionID: source.id, limit: 17 })
        expect(page.bootstrap).toMatchObject({ complete: false, scanned: 50, total: 510 })
        return page.bootstrap!.scanned
      }).pipe(Effect.provide(state(directory)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const reports = RayaRoutineReports.make({ storage, sessions, scope: source })
        const resumed = yield* reports.page({ sessionID: source.id, limit: 17 })
        expect(resumed.bootstrap?.scanned).toBe(first + 50)
        for (let count = 0; count < 9; count++) yield* reports.page({ sessionID: source.id, limit: 17 })
        const page = yield* reports.page({ sessionID: source.id, limit: 17 })
        expect(page.bootstrap).toMatchObject({ complete: true, scanned: 510, total: 510 })
        const wide = yield* reports.page({ sessionID: source.id, limit: 200 })
        expect(wide.items.length).toBeLessThan(200)
        expect(wide.next).toBeDefined()
        expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThanOrEqual(1024 * 1024)
        const items = [...page.items]
        let cursor = page.next
        while (cursor) {
          const next = yield* reports.page({ sessionID: source.id, cursor, limit: 17 })
          expect(next.items.length).toBeLessThanOrEqual(17)
          expect(Buffer.byteLength(JSON.stringify(next.items))).toBeLessThanOrEqual(1024 * 1024)
          items.push(...next.items)
          cursor = next.next
        }
        expect(items).toHaveLength(255)
        expect(new Set(items.map((card) => card.id)).size).toBe(255)
        expect(items[0].id).toBe("legacy-508")
        expect(items.at(-1)?.id).toBe("legacy-0")
        expect(yield* storage.list(["raya", "routine-reports"])).toHaveLength(510)
        expect(yield* storage.read(["raya", "routine-reports", hash("legacy-0")])).toMatchObject({
          revision: 1,
          summary: "界".repeat(8000),
        })
        const worker = yield* RayaTask.make({ storage }).create({
          name: "New",
          objective: "Report",
          schedule: { kind: "manual" },
          sourceSessionID: source.id,
        })
        const value = { agent: worker, id: "new", at: 1000, summary: "New result" }
        const saved = yield* reports.publishDeferred(value)
        const pointers = yield* storage.list(["raya", "routine-report-index", hash(source.id)])
        const pointer = pointers.find((key) => key.at(-1)?.endsWith(hash("new")))!
        yield* storage.remove(pointer)
        expect((yield* reports.publishDeferred(value))?.revision).toBe(saved?.revision)
        expect(yield* storage.read(pointer)).toMatchObject({ id: "new" })
        expect((yield* reports.page({ sessionID: source.id, limit: 17 })).items[0].id).toBe("new")
        const foreign = RayaRoutineReports.make({ storage, sessions, scope: other })
        expect(yield* foreign.page({ sessionID: other.id, cursor: page.next }).pipe(Effect.exit)).toMatchObject({
          _tag: "Failure",
        })
      }).pipe(Effect.provide(state(directory)))
    }),
  60_000,
)
