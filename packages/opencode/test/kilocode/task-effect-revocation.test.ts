import { expect } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { createHash } from "node:crypto"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectParticipant as Participants,
  RoutineEffectCapsule as Capsules,
  RoutineEffectMembership as Memberships,
  RoutineEffectAttempt as Attempts,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { make, Refusal } from "@/kilocode/task/effect-revocation"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const request = {
  request: "9".repeat(64),
  reason: "Routine authority changed",
  keys: [{ kind: "principal", principal: "worker" }],
}

function seed(database: Database.Interface, principal: string, digit: string) {
  return Effect.gen(function* () {
    const db = database.db
    const generation = digit.repeat(32)
    const scope = {
      id: digit.repeat(64),
      kind: "principal" as const,
      principal,
      birth: digit,
      generation,
      projection: "b".repeat(64),
      state: "active" as const,
    }
    const capsule = {
      id: digit.repeat(32),
      participant: digit.repeat(32),
      generation,
      run: `run-${digit}`,
      session: `session-${digit}`,
      step: `step-${digit}`,
      owner: "c".repeat(64),
      projection: "d".repeat(64),
      state: "active" as const,
    }
    // Synthetic SQL states test negative barriers only. No native participant,
    // enrolled writer, current run capability, or permission to POST is claimed.
    yield* db
      .insert(Participants)
      .values({
        id: capsule.participant,
        profile: "e".repeat(64),
        protocol: "raya.routine.effect.v1",
        cohort: "f".repeat(64),
        pid: 123,
        birth: digit,
        state: "qualified",
      })
      .run()
    yield* db.insert(Scopes).values(scope).run()
    yield* db.insert(Capsules).values(capsule).run()
    yield* db.insert(Memberships).values({ capsule: capsule.id, scope: scope.id, generation }).run()
    yield* db
      .insert(Attempts)
      .values({
        id: digit.repeat(31) + "0",
        capsule: capsule.id,
        generation,
        kind: "model",
        purpose: "model:original",
        digest: "a".repeat(64),
        owner: capsule.owner,
        state: "started",
      })
      .run()
    return { scope, capsule }
  })
}

function snapshot(database: Database.Interface) {
  return Effect.gen(function* () {
    const db = database.db
    return {
      scopes: yield* db.select().from(Scopes).orderBy(Scopes.id).all(),
      capsules: yield* db.select().from(Capsules).orderBy(Capsules.id).all(),
      attempts: yield* db.select().from(Attempts).orderBy(Attempts.id).all(),
      intents: yield* db.select().from(Revocations).orderBy(Revocations.id).all(),
    }
  }).pipe(Effect.orDie)
}

it.live(
  "selected SQLite negative barrier commits before real FS publication and preserves unrelated scopes and original attempts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const file = path.join(root, "authority.sqlite")
      const dir = path.join(root, "storage")
      const target = path.join(dir, "payload.json")
      const fs = yield* FSUtil.Service
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const own = yield* seed(database, "worker", "1")
        const other = yield* seed(database, "other", "2")
        const before = yield* snapshot(database)
        const api = make(database)
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          yield* storage.replace(["payload"], { version: 1 })
          const owner = yield* api.revoke(request)
          // Inspect the actual committed rows before invoking the real publication.
          const revoked = yield* snapshot(database)
          expect(revoked.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
          expect(revoked.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
          expect(revoked.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
          expect(revoked.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
          expect(revoked.attempts).toEqual(before.attempts)
          expect(revoked.intents).toHaveLength(1)
          expect(revoked.intents[0]).toMatchObject({
            scope: own.scope.id,
            generation: own.scope.generation,
            projection: own.scope.projection,
            request: request.request,
            state: "requested",
          })
          expect(yield* fs.readJson(target)).toEqual({ version: 1 })
          expect(yield* api.revoke(request).pipe(Effect.flip)).toBeInstanceOf(Refusal)
          expect(yield* make(database).revoke(structuredClone(request)).pipe(Effect.flip)).toBeInstanceOf(Refusal)
          expect(yield* snapshot(database)).toEqual(revoked)
          yield* storage.replace(["payload"], { version: 2 })
          yield* api.finish(owner, "published")
          yield* api.finish(owner, "published")
          expect(yield* fs.readJson(target)).toEqual({ version: 2 })
          const published = yield* snapshot(database)
          expect(published.intents[0]).toEqual({ ...revoked.intents[0], state: "published" })
          expect(published.scopes).toEqual(revoked.scopes)
          expect(published.capsules).toEqual(revoked.capsules)
          expect(published.attempts).toEqual(before.attempts)
          const next = yield* api.revoke({ ...request, request: "8".repeat(64) })
          yield* storage.replace(["payload"], { version: 3 })
          yield* api.finish(next, "published")
          expect(yield* snapshot(database)).toEqual(published)
          expect(yield* fs.readJson(target)).toEqual({ version: 3 })
          expect(yield* make(database).finish(owner, "published").pipe(Effect.flip)).toBeInstanceOf(Refusal)
          expect(yield* api.finish(structuredClone(owner), "published").pipe(Effect.flip)).toBeInstanceOf(Refusal)
        }).pipe(Effect.provide(Storage.layerFromDir(dir)))
      }).pipe(Effect.provide(Database.layerFromPath(file)))
    }),
)

it.live(
  "real central Storage roster publication commits revocation first while avatar and heartbeat changes remain benign",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const file = path.join(root, "authority.sqlite")
      const dir = path.join(root, "storage")
      const target = path.join(dir, "raya", "agent.json")
      const fs = yield* FSUtil.Service
      const roster = [
        { id: "worker", name: "Original label", objective: "Original objective", enabled: true, updatedAt: 1 },
      ]
      const run = "original-run"
      const key = ["raya", "agent-executions", createHash("sha256").update(run).digest("hex")]
      const record = {
        version: 1,
        agentID: "worker",
        runID: run,
        sessionID: "original-session",
        token: "00000000-0000-0000-0000-000000000001",
        owner: { host: "owned", pid: 123, birth: "1" },
        createdAt: 1,
        updatedAt: 1,
        state: "active",
      }
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          yield* storage.replace(["raya", "agent"], roster)
          yield* storage.replace(key, record)
        }).pipe(
          Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          Effect.scoped,
        )
        const own = yield* seed(database, "worker", "1")
        const other = yield* seed(database, "other", "2")
        const before = yield* snapshot(database)
        const peer = yield* Effect.acquireRelease(
          Effect.sync(() => new SQLite(file)),
          (peer) => Effect.sync(() => peer.close()),
        )
        const seen: string[] = []
        const observed: FSUtil.Interface = {
          ...fs,
          rename: (from, to) =>
            to === target
              ? Effect.gen(function* () {
                  const original = yield* fs.readJson(target).pipe(Effect.orDie)
                  if (Array.isArray(original) && original[0]?.avatar === "new-avatar") {
                    expect(
                      peer.query("SELECT state FROM raya_routine_effect_scope WHERE id = ?").get(own.scope.id),
                    ).toEqual({ state: "revoking" })
                    expect(
                      peer.query("SELECT state FROM raya_routine_effect_capsule WHERE id = ?").get(own.capsule.id),
                    ).toEqual({ state: "revoked" })
                    expect(
                      peer.query("SELECT state FROM raya_routine_effect_revocation WHERE scope = ?").all(own.scope.id),
                    ).toEqual([{ state: "requested" }])
                    seen.push("revoked-before-real-rename")
                  }
                  return yield* fs.rename(from, to)
                })
              : fs.rename(from, to),
        }
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const renamed = [{ ...roster[0], avatar: "new-avatar", updatedAt: 2 }]
          yield* storage.replace(["raya", "agent"], renamed)
          expect(yield* snapshot(database)).toEqual(before)
          const calls: number[] = []
          yield* storage.update<typeof record>(key, (value) => {
            calls.push(value.updatedAt)
            value.updatedAt = 2
          })
          expect(calls).toEqual([1])
          expect(yield* storage.read(key)).toEqual({ ...record, updatedAt: 2 })
          expect(yield* snapshot(database)).toEqual(before)
          yield* storage.replace(["raya", "agent"], [{ ...renamed[0], objective: "Changed objective" }])
          expect(seen).toEqual(["revoked-before-real-rename"])
          const after = yield* snapshot(database)
          expect(after.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
          expect(after.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
          expect(after.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
          expect(after.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
          expect(after.attempts).toEqual(before.attempts)
          expect(after.intents).toHaveLength(1)
          expect(after.intents[0]).toMatchObject({
            scope: own.scope.id,
            generation: own.scope.generation,
            state: "published",
          })
          expect(yield* storage.read(["raya", "agent"])).toEqual([{ ...renamed[0], objective: "Changed objective" }])
        }).pipe(
          Effect.provide(
            Storage.layerWithDatabase(dir).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(FSUtil.Service, observed), Layer.succeed(Database.Service, database)),
              ),
            ),
          ),
        )
      }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
    }),
)

it.live("central Storage actual FS error preserves original roster and durable uncertain revocation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const file = path.join(root, "authority.sqlite")
    const dir = path.join(root, "storage")
    const target = path.join(dir, "raya", "agent.json")
    const fs = yield* FSUtil.Service
    const roster = [{ id: "worker", name: "Original", objective: "Original", enabled: true }]
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* Effect.gen(function* () {
        yield* (yield* Storage.Service).replace(["raya", "agent"], roster)
      }).pipe(
        Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
        Effect.scoped,
      )
      const bytes = yield* fs.readFile(target)
      const own = yield* seed(database, "worker", "1")
      const other = yield* seed(database, "other", "2")
      const before = yield* snapshot(database)
      const observed: FSUtil.Interface = {
        ...fs,
        rename: (from, to) =>
          to === target
            ? Effect.gen(function* () {
                expect((yield* snapshot(database)).intents[0]?.state).toBe("requested")
                return yield* fs.rename(from, path.join(root, "absent", "agent.json"))
              })
            : fs.rename(from, to),
      }
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const exit = yield* storage.replace(["raya", "agent"], [{ ...roster[0], enabled: false }]).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.readFile(target)).toEqual(bytes)
        const after = yield* snapshot(database)
        expect(after.intents).toHaveLength(1)
        expect(after.intents[0]).toMatchObject({ scope: own.scope.id, state: "uncertain" })
        expect(after.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
        expect(after.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
        expect(after.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
        expect(after.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
        expect(after.attempts).toEqual(before.attempts)
        expect(
          Exit.isFailure(
            yield* storage.replace(["raya", "agent"], [{ ...roster[0], objective: "New authority" }]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* fs.readFile(target)).toEqual(bytes)
        expect(yield* snapshot(database)).toEqual(after)
      }).pipe(
        Effect.provide(
          Storage.layerWithDatabase(dir).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(FSUtil.Service, observed), Layer.succeed(Database.Service, database)),
            ),
          ),
        ),
      )
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
  }),
)

it.live(
  "central Storage update callback runs once and actual external byte drift refuses publication with retained debt",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const file = path.join(root, "authority.sqlite")
      const dir = path.join(root, "storage")
      const target = path.join(dir, "raya", "agent.json")
      const fs = yield* FSUtil.Service
      const roster = [{ id: "worker", name: "Original", objective: "Original", enabled: true }]
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        yield* Effect.gen(function* () {
          yield* (yield* Storage.Service).replace(["raya", "agent"], roster)
        }).pipe(
          Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          Effect.scoped,
        )
        const own = yield* seed(database, "worker", "1")
        const other = yield* seed(database, "other", "2")
        const before = yield* snapshot(database)
        const calls: string[] = []
        const opens: string[] = []
        const foreign = [{ ...roster[0], objective: "Actual external edit" }]
        const observed: FSUtil.Interface = {
          ...fs,
          open: (name, options) =>
            Effect.gen(function* () {
              if (name === target) {
                opens.push(name)
                if (opens.length === 2) {
                  expect((yield* snapshot(database)).intents[0]?.state).toBe("requested")
                  // A real external write changes the original CAS bytes. It does not
                  // grant an enrolled writer or substitute a new publication owner.
                  yield* fs.writeFileString(target, JSON.stringify(foreign))
                }
              }
              return yield* fs.open(name, options)
            }),
        }
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const exit = yield* storage
            .update<typeof roster>(["raya", "agent"], (rows) => {
              calls.push(rows[0].objective)
              rows[0].objective = "Requested edit"
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(calls).toEqual(["Original"])
          expect(opens).toHaveLength(2)
          expect(yield* fs.readJson(target)).toEqual(foreign)
          const after = yield* snapshot(database)
          expect(after.intents[0]).toMatchObject({ scope: own.scope.id, state: "uncertain" })
          expect(after.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
          expect(after.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
          expect(after.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
          expect(after.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
          expect(after.attempts).toEqual(before.attempts)
        }).pipe(
          Effect.provide(
            Storage.layerWithDatabase(dir).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(FSUtil.Service, observed), Layer.succeed(Database.Service, database)),
              ),
            ),
          ),
        )
      }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
    }),
)

it.live(
  "case aliases refuse rather than bypassing authority, and worker name changes revoke their exact principal",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const file = path.join(root, "authority.sqlite")
      const dir = path.join(root, "storage")
      const fs = yield* FSUtil.Service
      const roster = [{ id: "worker", name: "Original", objective: "Original", enabled: true }]
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        yield* Effect.gen(function* () {
          yield* (yield* Storage.Service).replace(["raya", "agent"], roster)
        }).pipe(
          Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
          Effect.scoped,
        )
        const own = yield* seed(database, "worker", "1")
        const other = yield* seed(database, "other", "2")
        const before = yield* snapshot(database)
        const target = path.join(dir, "raya", "agent.json")
        const bytes = yield* fs.readFile(target)
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          for (const key of [
            ["RAYA", "agent"],
            ["raya", "AGENT"],
          ]) {
            expect(
              Exit.isFailure(yield* storage.replace(key, [{ ...roster[0], enabled: false }]).pipe(Effect.exit)),
            ).toBe(true)
            expect(yield* fs.readFile(target)).toEqual(bytes)
            expect(yield* snapshot(database)).toEqual(before)
          }
          // An existing malformed authority file makes create a no-op, never an authority read or publication.
          yield* fs.writeFileString(target, "malformed")
          expect(yield* storage.create(["raya", "agent"], roster)).toBe(false)
          expect(yield* fs.readFileString(target)).toBe("malformed")
          expect(yield* snapshot(database)).toEqual(before)
          yield* fs.writeFile(target, bytes)
          yield* storage.replace(["raya", "agent"], [{ ...roster[0], name: "Semantic prompt name changed" }])
          const after = yield* snapshot(database)
          expect(after.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
          expect(after.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
          expect(after.intents[0]?.state).toBe("published")
          expect(after.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
          expect(after.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
          expect(after.attempts).toEqual(before.attempts)
        }).pipe(
          Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
        )
      }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
    }),
)

it.live("unbound and nonphysical selected databases cannot admit authority writes or claim participation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const mode of ["missing", "memory"]) {
      const dir = path.join(root, mode, "storage")
      const target = path.join(dir, "raya", "agent.json")
      const original = [{ id: "worker", name: "Original", objective: "Original", enabled: true }]
      yield* fs.writeWithDirs(target, JSON.stringify(original))
      const bytes = yield* fs.readFile(target)
      const body = Effect.gen(function* () {
        const storage = yield* Storage.Service
        const exit = yield* storage.replace(["raya", "agent"], [{ ...original[0], enabled: false }]).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.readFile(target)).toEqual(bytes)
        // Ordinary unrelated JSON remains supported; it provides no Routine
        // participant or enrolled-writer authority.
        yield* storage.replace(["payload"], { supported: true })
        expect(yield* storage.read(["payload"])).toEqual({ supported: true })
      })
      if (mode === "missing") yield* body.pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.scoped)
      if (mode === "memory")
        yield* body.pipe(
          Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Database.layerFromPath(":memory:")))),
          Effect.scoped,
        )
    }
  }),
)

it.live("real publication failure retains original FS bytes, uncertain intent, and settlement debt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const file = path.join(root, "authority.sqlite")
    const dir = path.join(root, "storage")
    const target = path.join(dir, "payload.json")
    const fs = yield* FSUtil.Service
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database, "worker", "1")
      yield* seed(database, "other", "2")
      const before = yield* snapshot(database)
      yield* fs.writeWithDirs(target, JSON.stringify({ version: 1 }))
      const bytes = yield* fs.readFile(target)
      const api = make(database)
      const owner = yield* api.revoke(request)
      const revoked = yield* snapshot(database)
      const observed: FSUtil.Interface = {
        ...fs,
        // Fault injection delegates to an actual owned FS rename with an absent
        // parent. No replacement publisher or synthetic error is implemented.
        rename: (from, to) =>
          to === target
            ? Effect.gen(function* () {
                expect(yield* snapshot(database)).toEqual(revoked)
                return yield* fs.rename(from, path.join(root, "absent", "payload.json"))
              })
            : fs.rename(from, to),
      }
      const failed = yield* Effect.gen(function* () {
        yield* (yield* Storage.Service).replace(["payload"], { version: 2 })
      }).pipe(
        Effect.provide(Storage.layerFromDir(dir).pipe(Layer.provide(Layer.succeed(FSUtil.Service, observed)))),
        Effect.exit,
      )
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* fs.readFile(target)).toEqual(bytes)
      expect(yield* snapshot(database)).toEqual(revoked)
      yield* api.finish(owner, "uncertain")
      const uncertain = yield* snapshot(database)
      expect(uncertain.intents).toEqual(revoked.intents.map((row) => ({ ...row, state: "uncertain" })))
      expect(uncertain.scopes).toEqual(revoked.scopes)
      expect(uncertain.capsules).toEqual(revoked.capsules)
      expect(uncertain.attempts).toEqual(before.attempts)
      expect(yield* api.revoke({ ...request, request: "8".repeat(64) }).pipe(Effect.flip)).toBeInstanceOf(Refusal)
      expect(yield* make(database).revoke(request).pipe(Effect.flip)).toBeInstanceOf(Refusal)
      expect(yield* api.finish(owner, "published").pipe(Effect.flip)).toBeInstanceOf(Refusal)
      expect(yield* snapshot(database)).toEqual(uncertain)
    }).pipe(Effect.provide(Database.layerFromPath(file)))
  }),
)

it.live("cancellation joins the real uninterruptible publication and retains revocation without reactivation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const file = path.join(root, "authority.sqlite")
    const dir = path.join(root, "storage")
    const target = path.join(dir, "payload.json")
    const fs = yield* FSUtil.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database, "worker", "1")
      yield* fs.writeWithDirs(target, JSON.stringify({ version: 1 }))
      const api = make(database)
      yield* api.revoke(request)
      const revoked = yield* snapshot(database)
      const observed: FSUtil.Interface = {
        ...fs,
        rename: (from, to) =>
          to === target
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.rename(from, to)),
              )
            : fs.rename(from, to),
      }
      yield* Effect.gen(function* () {
        const write = yield* (yield* Storage.Service).replace(["payload"], { version: 2 }).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        expect(yield* snapshot(database)).toEqual(revoked)
        // Storage owns its real FS publication until settlement. Request
        // interruption concurrently, then release its original operation before
        // joining both fibers; cancellation must not be mistaken for no write.
        const stopping = yield* Fiber.interrupt(write).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(stopping.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopping)
        const exit = yield* Fiber.await(write)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.readJson(target)).toEqual({ version: 2 })
        expect(yield* snapshot(database)).toEqual(revoked)
        expect(
          yield* make(database)
            .revoke({ ...request, request: "8".repeat(64) })
            .pipe(Effect.flip),
        ).toBeInstanceOf(Refusal)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(Storage.layerFromDir(dir).pipe(Layer.provide(Layer.succeed(FSUtil.Service, observed)))),
      )
    }).pipe(Effect.provide(Database.layerFromPath(file)))
  }),
)

it.live(
  "fresh physical DB and Storage services retain unresolved original intents without replay or reconstruction",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const file = path.join(root, "authority.sqlite")
      const dir = path.join(root, "storage")
      const fs = yield* FSUtil.Service
      const original = yield* Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database, "worker", "1")
        yield* seed(database, "other", "2")
        yield* Effect.gen(function* () {
          yield* (yield* Storage.Service).replace(["payload"], { version: 1 })
        }).pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.scoped)
        const owner = yield* make(database).revoke(request)
        return { owner, rows: yield* snapshot(database), bytes: yield* fs.readFile(path.join(dir, "payload.json")) }
      }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
      // Both original service scopes are closed. This is a physical-service cold
      // read in the same test process, not a native restart/enrollment claim.
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const api = make(database)
        expect(yield* snapshot(database)).toEqual(original.rows)
        expect(yield* api.revoke(request).pipe(Effect.flip)).toBeInstanceOf(Refusal)
        expect(yield* api.finish(original.owner, "published").pipe(Effect.flip)).toBeInstanceOf(Refusal)
        yield* Effect.gen(function* () {
          expect(yield* (yield* Storage.Service).read(["payload"])).toEqual({ version: 1 })
        }).pipe(Effect.provide(Storage.layerFromDir(dir)), Effect.scoped)
        expect(yield* fs.readFile(path.join(dir, "payload.json"))).toEqual(original.bytes)
        expect(yield* snapshot(database)).toEqual(original.rows)
      }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
    }),
)

it.live("central Storage cancellation joins original publication and settles its automatic revocation uncertain", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const file = path.join(root, "authority.sqlite")
    const dir = path.join(root, "storage")
    const target = path.join(dir, "raya", "agent.json")
    const fs = yield* FSUtil.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const roster = [{ id: "worker", name: "Original", objective: "Original", enabled: true }]
    const next = [{ ...roster[0], objective: "Original requested change" }]
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* Effect.gen(function* () {
        yield* (yield* Storage.Service).replace(["raya", "agent"], roster)
      }).pipe(
        Effect.provide(Storage.layerWithDatabase(dir).pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
        Effect.scoped,
      )
      const own = yield* seed(database, "worker", "1")
      const other = yield* seed(database, "other", "2")
      const before = yield* snapshot(database)
      const observed: FSUtil.Interface = {
        ...fs,
        rename: (from, to) =>
          to === target
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.rename(from, to)),
              )
            : fs.rename(from, to),
      }
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const write = yield* storage.replace(["raya", "agent"], next).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const revoked = yield* snapshot(database)
        expect(revoked.intents).toHaveLength(1)
        expect(revoked.intents[0]).toMatchObject({ scope: own.scope.id, state: "requested" })
        expect(revoked.scopes.find((row) => row.id === own.scope.id)?.state).toBe("revoking")
        expect(revoked.capsules.find((row) => row.id === own.capsule.id)?.state).toBe("revoked")
        expect(yield* fs.readJson(target)).toEqual(roster)
        const stopping = yield* Fiber.interrupt(write).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(stopping.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopping)
        expect(Exit.isFailure(yield* Fiber.await(write))).toBe(true)
        expect(yield* fs.readJson(target)).toEqual(next)
        const after = yield* snapshot(database)
        expect(after.intents).toEqual(revoked.intents.map((row) => ({ ...row, state: "uncertain" })))
        expect(after.scopes).toEqual(revoked.scopes)
        expect(after.capsules).toEqual(revoked.capsules)
        expect(after.scopes.find((row) => row.id === other.scope.id)).toEqual(other.scope)
        expect(after.capsules.find((row) => row.id === other.capsule.id)).toEqual(other.capsule)
        expect(after.attempts).toEqual(before.attempts)
        expect(Exit.isFailure(yield* storage.replace(["raya", "agent"], roster).pipe(Effect.exit))).toBe(true)
        expect(yield* fs.readJson(target)).toEqual(next)
        expect(yield* snapshot(database)).toEqual(after)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          Storage.layerWithDatabase(dir).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(FSUtil.Service, observed), Layer.succeed(Database.Service, database)),
            ),
          ),
        ),
      )
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
  }),
)
