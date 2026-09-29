import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Exit, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { Git } from "@/git"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { Journal } from "@/kilocode/task/delegation-review"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (dir: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(dir, "storage")),
    Database.layerFromPath(path.join(dir, "delegation.sqlite")),
  )
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const agent = (id: string): RayaTask.Agent => ({
  id,
  name: id,
  role: "generalist",
  objective: `${id} standing work`,
  capabilities: [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
})

const setup = Effect.fn(function* (shared = { value: false }) {
  const database = yield* Database.Service
  const storage = yield* Storage.Service
  const execution = RayaTaskExecution.make(storage)
  const store = RayaTaskDelegation.make(database, undefined, () => Effect.succeed(shared.value), {
    storage,
    receipt: execution.receipt,
    reviewed: execution.reviewed,
    guard: () => Effect.void,
  })
  const sender = agent("delegation_sender")
  const recipient = agent("delegation_recipient")
  yield* store.admit(
    {
      source: `review_${crypto.randomUUID()}`,
      senderID: sender.id,
      recipientID: recipient.id,
      objective: "Continue the reviewed delegated reply.",
      deadline: Date.now() + 60_000,
      budget: 12,
    },
    sender,
    recipient,
  )
  const taken = yield* store.take(recipient.id)
  if (!taken?.childRunID) throw new Error("Expected accepted delegation")
  const sid = SessionID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
  yield* store.attach(taken.id, taken.childRunID, sid)
  const waiting = yield* store.finish(
    taken.id,
    "needs_input",
    recipient,
    undefined,
    3,
    "A reviewed answer is required.",
  )
  const run: RayaTask.Run = {
    id: taken.childRunID,
    agentID: recipient.id,
    sessionID: sid,
    at: Date.now(),
    status: "blocked",
    blockedReason: "A reviewed answer is required.",
  }
  yield* execution.enter(run, Effect.fail("uncertain delegated reply")).pipe(Effect.exit)
  const receipt = yield* execution.receipt(run)
  if (!receipt) throw new Error("Expected retained execution receipt")
  const ctx = { intent: "reviewed delegated reply", source: "user reply", execution: hash(receipt.token) }
  return { database, storage, execution, store, shared, recipient, waiting, run, receipt, ctx }
})

it.live(
  "binds delegated review provenance before execution review and recovers an interrupted SQL rearm exactly once",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        const before = yield* fixture.store.get(fixture.waiting.id)
        yield* fixture.store.review(fixture.waiting.id, fixture.run, fixture.ctx)
        const prepared = yield* fixture.storage
          .read(["raya", "delegation-reviews", hash(fixture.waiting.id)])
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
        expect(prepared).toMatchObject({ phase: "prepared", prior: { state: "needs_input" }, review: fixture.ctx })
        yield* fixture.execution.review(fixture.run, fixture.receipt.token)
        yield* fixture.database.db.run(`
          CREATE TRIGGER fail_delegation_rearm
          BEFORE UPDATE ON raya_routine_delegation
          WHEN OLD.id = '${fixture.waiting.id}' AND NEW.state = 'running'
          BEGIN
            SELECT RAISE(ABORT, 'injected delegation rearm failure');
          END
        `)
        expect(
          Exit.isFailure(yield* fixture.store.rearm(fixture.waiting.id, fixture.run, fixture.ctx).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* fixture.store.get(fixture.waiting.id)).toEqual(before)
        yield* fixture.database.db.run("DROP TRIGGER fail_delegation_rearm")
        const resumed = yield* fixture.store.rearm(fixture.waiting.id, fixture.run, fixture.ctx)
        expect(resumed).toMatchObject({
          id: before.id,
          source: before.source,
          senderID: before.senderID,
          recipientID: before.recipientID,
          childRunID: before.childRunID,
          sessionID: before.sessionID,
          deadline: before.deadline,
          budget: before.budget,
          cost: before.cost,
          reason: before.reason,
          state: "running",
        })
        expect(yield* fixture.store.rearm(fixture.waiting.id, fixture.run, fixture.ctx)).toEqual(resumed)
        const complete = yield* fixture.storage
          .read(["raya", "delegation-reviews", hash(fixture.waiting.id)])
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
        expect(complete.phase).toBe("complete")
        yield* fixture.store.review(fixture.waiting.id, fixture.run, fixture.ctx)
        expect(
          yield* fixture.storage
            .read(["raya", "delegation-reviews", hash(fixture.waiting.id)])
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal))),
        ).toEqual(complete)
      }).pipe(Effect.provide(state(dir)))
    }),
  30_000,
)

it.live(
  "rearms an initially running reviewed delegation and completes a persisted applied CAS without replay",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        const running = yield* fixture.store.resume(fixture.waiting.id, fixture.run.id, fixture.run.sessionID)
        yield* fixture.store.review(running.id, fixture.run, fixture.ctx)
        const prepared = yield* fixture.storage
          .read(["raya", "delegation-reviews", hash(running.id)])
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
        expect(prepared).toMatchObject({ phase: "prepared", prior: { state: "running" } })
        yield* fixture.execution.review(fixture.run, fixture.receipt.token)
        yield* fixture.database.db
          .update(Delegation)
          .set({ state: "running", time_updated: prepared.target.updated })
          .where(eq(Delegation.id, running.id))
          .run()
        const resumed = yield* fixture.store.rearm(running.id, fixture.run, fixture.ctx)
        expect(resumed).toMatchObject({ id: running.id, state: "running", sessionID: fixture.run.sessionID })
        const complete = yield* fixture.storage
          .read(["raya", "delegation-reviews", hash(running.id)])
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
        expect(complete.phase).toBe("complete")
        expect(
          Exit.isFailure(
            yield* fixture.store
              .rearm(running.id, fixture.run, { ...fixture.ctx, source: "changed review source" })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* fixture.store.finish(running.id, "completed", fixture.recipient, "Finished reviewed delegation.", 3)
        expect(
          Exit.isFailure(yield* fixture.store.review(running.id, fixture.run, fixture.ctx).pipe(Effect.exit)),
        ).toBe(true)
      }).pipe(Effect.provide(state(dir)))
    }),
  30_000,
)

it.live(
  "refuses changed delegated provenance and a new execution after the immutable review",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        yield* fixture.store.review(fixture.waiting.id, fixture.run, fixture.ctx)
        yield* fixture.execution.review(fixture.run, fixture.receipt.token)
        yield* fixture.database.db
          .update(Delegation)
          .set({ source: `changed_${crypto.randomUUID()}` })
          .where(eq(Delegation.id, fixture.waiting.id))
          .run()
        expect(
          Exit.isFailure(yield* fixture.store.rearm(fixture.waiting.id, fixture.run, fixture.ctx).pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* fixture.store.get(fixture.waiting.id)).state).toBe("needs_input")

        yield* fixture.database.db
          .update(Delegation)
          .set({ source: fixture.waiting.source })
          .where(eq(Delegation.id, fixture.waiting.id))
          .run()
        yield* fixture.execution.enter(fixture.run, Effect.fail("new uncertain delegated reply")).pipe(Effect.exit)
        expect(
          Exit.isFailure(yield* fixture.store.rearm(fixture.waiting.id, fixture.run, fixture.ctx).pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* fixture.store.get(fixture.waiting.id)).state).toBe("needs_input")

        const next = yield* setup()
        yield* next.store.review(next.waiting.id, next.run, next.ctx)
        yield* next.execution.review(next.run, next.receipt.token)
        yield* next.storage.remove(["raya", "delegation-reviews", hash(next.waiting.id)])
        const before = yield* next.store.get(next.waiting.id)
        expect(Exit.isFailure(yield* next.store.review(next.waiting.id, next.run, next.ctx).pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* next.storage.read(["raya", "delegation-reviews", hash(next.waiting.id)]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* next.store.get(next.waiting.id)).toEqual(before)
        expect(Exit.isFailure(yield* next.store.rearm(next.waiting.id, next.run, next.ctx).pipe(Effect.exit))).toBe(
          true,
        )
        expect((yield* next.store.get(next.waiting.id)).state).toBe("needs_input")
      }).pipe(Effect.provide(state(dir)))
    }),
  30_000,
)

it.live(
  "ordinary delegated resume rechecks sharing and deadline before changing state",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        fixture.shared.value = true
        expect(
          Exit.isFailure(
            yield* fixture.store.resume(fixture.waiting.id, fixture.run.id, fixture.run.sessionID).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* fixture.store.get(fixture.waiting.id)).state).toBe("needs_input")
        fixture.shared.value = false
        yield* fixture.database.db
          .update(Delegation)
          .set({ deadline: Date.now() - 1 })
          .where(eq(Delegation.id, fixture.waiting.id))
          .run()
        expect(
          Exit.isFailure(
            yield* fixture.store.resume(fixture.waiting.id, fixture.run.id, fixture.run.sessionID).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* fixture.store.get(fixture.waiting.id)).state).toBe("needs_input")
      }).pipe(Effect.provide(state(dir)))
    }),
  30_000,
)
