import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineMessageTable as Message,
  RayaRoutineOccurrenceTable as Occurrence,
} from "@opencode-ai/core/kilocode/routine.sql"
import { RayaTaskHealth } from "@/kilocode/task/health"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(directory, "storage")),
    Database.layerFromPath(path.join(directory, "health.sqlite")),
  )

it.live("projects queue, claim, staging, and inbox recovery without private payloads", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const summary = yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const now = 1_800_000_000_000
      yield* database.db
        .insert(Occurrence)
        .values([
          {
            id: "queued-private",
            agent_id: "agent-private",
            schedule_version: 1,
            scheduled_at: now,
            observed_at: now,
            state: "queued",
            time_updated: now,
          },
          {
            id: "active-private",
            agent_id: "agent-private",
            schedule_version: 1,
            scheduled_at: now + 1,
            observed_at: now,
            state: "linked",
            lease_until: now + 1_000,
            time_updated: now,
          },
          {
            id: "expired-private",
            agent_id: "agent-private",
            schedule_version: 1,
            scheduled_at: now + 2,
            observed_at: now,
            state: "starting",
            lease_until: now - 1,
            time_updated: now,
          },
        ])
        .run()
      yield* database.db
        .insert(Conversation)
        .values({ agent_id: "agent-private", id: "conversation-private", read_at: 0, time_updated: now })
        .run()
      yield* database.db
        .insert(Message)
        .values([
          {
            id: "pending-private",
            agent_id: "agent-private",
            source: "private-pending-source",
            kind: "user",
            body: "synthetic-pending-secret",
            time_created: now,
          },
          {
            id: "stranded-private",
            agent_id: "agent-private",
            source: "private-stranded-source",
            kind: "user",
            body: "synthetic-stranded-secret",
            session_id: "ses_private",
            time_created: now + 1,
          },
        ])
        .run()
      yield* storage.write(["raya", "agent-claims", "private-claim"], { token: "synthetic-claim-secret" })
      yield* storage.write(["raya", "agent-claims", createHash("sha256").update("valid-agent").digest("hex")], {
        version: 1,
        agentID: "valid-agent",
        id: "valid-claim",
        at: now,
        phase: "claimed",
        owner: { host: hostname(), pid: process.pid },
      })
      yield* storage.write(["raya", "agent-stage", "private-stage"], { token: "synthetic-stage-secret" })
      return yield* RayaTaskHealth.inspect(database, storage, now)
    }).pipe(Effect.provide(state(directory)))

    expect(summary).toEqual({
      queued: 1,
      active: 1,
      recovering: 2,
      claims: 2,
      staged: 1,
      pending: 1,
      stranded: 1,
      failed: 2,
      incomplete: 0,
    })
    expect(JSON.stringify(summary)).not.toContain("private")
    expect(JSON.stringify(summary)).not.toContain("synthetic")
  }),
)

it.live("caps scheduler storage reads and reports unchecked records", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    let reads = 0
    const summary = yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const keys = Array.from({ length: 260 }, (_, index) => ["raya", "agent-claims", `private-${index}`])
      return yield* RayaTaskHealth.inspect(
        database,
        {
          list: (prefix) => Effect.succeed(prefix[1] === "agent-claims" ? keys : []),
          read: <T>() => {
            reads++
            return Effect.succeed({ token: "synthetic-secret" } as T)
          },
        },
        1_800_000_000_000,
      )
    }).pipe(Effect.provide(state(directory)))

    expect(reads).toBe(256)
    expect(summary).toMatchObject({ claims: 260, failed: 256, incomplete: 4 })
    expect(JSON.stringify(summary)).not.toContain("private")
    expect(JSON.stringify(summary)).not.toContain("synthetic")
  }),
)
