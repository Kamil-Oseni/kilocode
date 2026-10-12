import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { history } from "@/kilocode/task/report-history"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Storage.layerFromDir(path.join(directory, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(directory, "history.sqlite"))),
  )
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

it.live("report index pointers and bootstrap retire only their own configuration authority", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const fs = yield* FSUtil.Service
      const card: RayaRoutineReports.Card = {
        version: 1,
        id: "indexed-occurrence",
        agentID: "observed-worker",
        runID: "observed-run",
        name: "Worker",
        reportSessionID: SessionID.make("ses_observed"),
        workerSessionID: SessionID.make("ses_worker"),
        projectID: "global",
        directory,
        revision: 1,
        status: "complete",
        at: 0,
        summary: "Result",
        delivery: "delivered",
      }
      const pointer = [hash(card.reportSessionID), `8000000000000000-${hash(card.id)}`]
      const principals = [
        ["config", `routine-report-index:${hash(JSON.stringify(pointer))}`],
        ["config", `routine-report-index:${hash(JSON.stringify(["bootstrap"]))}`],
        ["principal", card.agentID],
        ["run", card.runID!],
        ["session", card.reportSessionID],
        ["session", card.workerSessionID!],
        ["config", "unrelated-config"],
      ] as const
      // Negative associations grant no execution authority. The actual physical
      // Storage publications below must retire only each derived index scope.
      for (const [index, [kind, principal]] of principals.entries()) {
        const digit = (index + 1).toString(16)
        yield* database.db
          .insert(Scopes)
          .values({
            id: digit.repeat(64),
            kind,
            principal,
            birth: "1",
            generation: digit.repeat(32),
            projection: "c".repeat(64),
            state: "active",
          })
          .run()
      }
      yield* fs.writeWithDirs(
        path.join(directory, "storage", "raya", "routine-reports", `${hash(card.id)}.json`),
        JSON.stringify(card),
      )
      const index = history(storage, Schema.decodeUnknownEffect(RayaRoutineReports.Card))
      expect(yield* index.upsert(card)).toBe(true)
      const read = () => database.db.select().from(Scopes).all()
      const published = yield* read()
      expect(published.find((row) => row.principal === principals[0][1])?.state).toBe("revoking")
      expect(published.filter((row) => row.principal !== principals[0][1]).every((row) => row.state === "active")).toBe(
        true,
      )
      expect(yield* index.bootstrap()).toMatchObject({ complete: true, scanned: 1, total: 1 })
      const scopes = yield* read()
      expect(
        scopes
          .filter((row) => principals.slice(0, 2).some(([, principal]) => row.principal === principal))
          .map((row) => row.state),
      ).toEqual(["revoking", "revoking"])
      expect(
        scopes
          .filter((row) => principals.slice(2).some(([, principal]) => row.principal === principal))
          .map((row) => row.state),
      ).toEqual(Array(5).fill("active"))
      expect((yield* database.db.select().from(Revocations).all()).map((row) => row.state)).toEqual([
        "published",
        "published",
      ])
    }).pipe(Effect.provide(state(directory)))
  }),
)
