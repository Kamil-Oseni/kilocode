import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { patches } from "@/kilocode/session/review-history"
import { provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionSummary.node,
    Storage.node,
    CrossSpawnSpawner.node,
    Database.node,
  ]),
)
const it = testEffect(env)

it.live(
  "patch reads isolate sessions, reflect deletions, and reject malformed metadata",
  provideTmpdirProject(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const target = yield* sessions.create({})
        const other = yield* sessions.create({})
        const entries = []
        for (const session of [target, other]) {
          const message = MessageID.ascending()
          const part = PartID.ascending()
          yield* sessions.updateMessage({
            id: message,
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: part,
            messageID: message,
            sessionID: session.id,
            type: "patch",
            hash: "fixture",
            files: ["shared.ts"],
          })
          entries.push({ sessionID: session.id, messageID: message, partID: part })
        }
        const selected = yield* patches(database.db, target.id)
        expect(selected.map((patch) => patch.message)).toEqual([entries[0].messageID])
        yield* sessions.removePart(entries[0])
        expect(yield* patches(database.db, target.id)).toEqual([])
        expect(yield* patches(database.db, other.id)).toHaveLength(1)
        yield* database.db
          .run(
            sql`UPDATE part SET data = ${JSON.stringify({ type: "patch", files: [42] })} WHERE id = ${entries[1].partID}`,
          )
          .pipe(Effect.orDie)
        expect(Exit.isFailure(yield* Effect.exit(patches(database.db, other.id)))).toBe(true)
      }),
    { git: true },
  ),
  30_000,
)

it.live(
  "review identity remains correct with a large unrelated transcript",
  provideTmpdirProject(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const session = yield* sessions.create({})
        const text = "unrelated transcript ".repeat(3200)
        const ids: string[] = []
        for (let index = 0; index < 128; index++) {
          const message = MessageID.ascending()
          yield* sessions.updateMessage({
            id: message,
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: message,
            sessionID: session.id,
            type: "text",
            text,
          })
          if (index !== 0 && index !== 127) continue
          const part = PartID.ascending()
          yield* sessions.updatePart({
            id: part,
            messageID: message,
            sessionID: session.id,
            type: "patch",
            hash: "fixture",
            files: ["file.ts"],
          })
          ids.push(`${message}:${part}`)
        }
        yield* storage.write(
          ["session_diff", session.id],
          [{ file: "file.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }],
        )
        const samples: number[] = []
        for (let iteration = 0; iteration < 5; iteration++) {
          const start = performance.now()
          const diffs = yield* summary.diff({ sessionID: session.id })
          samples.push(performance.now() - start)
          expect(diffs).toHaveLength(1)
          expect(diffs[0].generation).toBe(ids[1])
          expect(diffs[0].reviewed).toBe("")
        }
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(messages).toHaveLength(128)
        const selected = yield* patches(database.db, session.id)
        expect(selected).toHaveLength(2)
        expect(selected.map((patch) => patch.generation).sort()).toEqual(ids)
        expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(1024)
        console.info(
          "Review history workload",
          JSON.stringify({
            messages: messages.length,
            transcriptBytes: Buffer.byteLength(JSON.stringify(messages)),
            patchBytes: Buffer.byteLength(JSON.stringify(selected)),
            medianMs: samples.sort((a, b) => a - b)[2],
          }),
        )
      }),
    { git: true },
  ),
  60_000,
)
