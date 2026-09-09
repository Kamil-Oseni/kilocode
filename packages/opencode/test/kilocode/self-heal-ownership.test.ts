import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const source = { root: "/verified/raya", commit: "a".repeat(40) }
function instance<A, E>(
  directory: string,
  run: (backlog: ReturnType<typeof RayaSelfHeal.make>, storage: Storage.Interface) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const storage = yield* Storage.Service
    return yield* run(RayaSelfHeal.make(storage), storage)
  }).pipe(Effect.provide(Storage.layerFromDir(directory)))
}
it.live(
  "independent Storage instances converge intake and reserve one repair across restart",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const rows = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          instance(directory, (backlog) => backlog.create({ description: "Concurrent repair report" })),
        ),
        { concurrency: 8 },
      )
      expect(new Set(rows.map((row) => row.id)).size).toBe(1)
      const id = rows[0].id
      expect((yield* instance(directory, (backlog) => backlog.get(id)))?.reports).toBe(8)
      const claims = yield* Effect.all(
        Array.from({ length: 8 }, () => instance(directory, (backlog) => backlog.admit(id, { source }))),
        { concurrency: 8 },
      )
      expect(claims.filter((claim) => claim?.owned)).toHaveLength(1)
      expect(claims.filter((claim) => claim?.token)).toHaveLength(1)
      const owner = claims.find((claim) => claim?.owned)!
      const steps = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          instance(directory, (backlog) =>
            backlog.advance(id, { token: owner.token!, revision: 0, phase: "session_creating" }).pipe(Effect.exit),
          ),
        ),
        { concurrency: 8 },
      )
      expect(steps.filter(Exit.isSuccess)).toHaveLength(1)
      expect((yield* instance(directory, (backlog) => backlog.get(id)))?.repair?.phase).toBe("session_creating")
      expect((yield* instance(directory, (backlog) => backlog.admit(id, { source })))?.owned).toBe(false)
      expect(
        Exit.isFailure(
          yield* instance(directory, (backlog) =>
            backlog
              .advance(id, {
                token: "wrong",
                revision: 1,
                phase: "session_created",
                sessionID: SessionID.make("ses_wrong"),
              })
              .pipe(Effect.exit),
          ),
        ),
      ).toBe(true)
    }),
  30_000,
)
it.live("retains session identity and unknown dispatch without replay", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const item = yield* instance(directory, (backlog) =>
      backlog.create({ description: "Dispatch may have reached backend" }),
    )
    const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
    const phases = [
      "session_creating",
      "session_created",
      "goal_creating",
      "goal_created",
      "dispatching",
      "dispatch_unknown",
    ] as const
    for (const [revision, phase] of phases.entries())
      yield* instance(directory, (backlog) =>
        backlog.advance(item.id, {
          token: claim.token!,
          revision,
          phase,
          ...(phase === "session_created" ? { sessionID: SessionID.make("ses_retained") } : {}),
        }),
      )
    const reopened = (yield* instance(directory, (backlog) => backlog.get(item.id)))!
    expect(reopened.repair?.phase).toBe("dispatch_unknown")
    expect(reopened.repair?.sessionID).toBe(SessionID.make("ses_retained"))
    expect(reopened.repair?.reason).toContain("do not replay")
    expect(JSON.stringify(reopened)).not.toContain(claim.token!)
    expect((yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))?.owned).toBe(false)
    expect(
      Exit.isFailure(
        yield* instance(directory, (backlog) =>
          backlog.advance(item.id, { token: claim.token!, revision: 6, phase: "dispatching" }).pipe(Effect.exit),
        ),
      ),
    ).toBe(true)
  }),
)
it.live("preserves legacy conflicts and permits a new intake generation after closure", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const description = "Legacy duplicate report remains visible"
    const item = yield* instance(directory, (backlog) => backlog.create({ description }))
    yield* instance(directory, (_, storage) =>
      storage.write(["raya", "self-heal", "item", "heal_legacy"], {
        ...item,
        id: "heal_legacy",
        workSessionID: SessionID.make("ses_old"),
      }),
    )
    expect((yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))?.outcome.phase).toBe(
      "legacy_conflict",
    )
    yield* instance(directory, (backlog) => backlog.update(item.id, { status: "cancelled" }))
    yield* instance(directory, (backlog) => backlog.update("heal_legacy", { status: "cancelled" }))
    const next = yield* instance(directory, (backlog) => backlog.create({ description }))
    expect(next.id).not.toBe(item.id)
    expect(next.id).not.toBe("heal_legacy")
    expect(next.reports).toBe(1)
  }),
)

it.live(
  "every pre-dispatch crash boundary retains ownership and its last session across reopening",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const phases = ["session_creating", "session_created", "goal_creating", "goal_created"] as const
      for (const [boundary, stopped] of phases.entries()) {
        const item = yield* instance(directory, (backlog) =>
          backlog.create({ description: `Crash during ${stopped} boundary` }),
        )
        const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
        for (const [revision, phase] of phases.slice(0, boundary + 1).entries())
          yield* instance(directory, (backlog) =>
            backlog.advance(item.id, {
              token: claim.token!,
              revision,
              phase,
              ...(phase === "session_created" ? { sessionID: SessionID.make("ses_partial") } : {}),
            }),
          )
        const retained = (yield* instance(directory, (backlog) => backlog.get(item.id)))!.repair!
        expect(retained.phase).toBe(stopped)
        expect(retained.sessionID).toBe(boundary === 0 ? undefined : SessionID.make("ses_partial"))
        expect((yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))?.owned).toBe(false)
        const failure = yield* instance(directory, (backlog) =>
          backlog.advance(item.id, { token: claim.token!, revision: boundary + 1, phase: "blocked" }),
        )
        expect(failure.reason).toContain(stopped)
        yield* instance(directory, (backlog) => backlog.update(item.id, { status: "cancelled" }))
        const duplicate = yield* instance(directory, (backlog) =>
          backlog.create({ description: `Crash during ${stopped} boundary` }),
        )
        expect(duplicate.id).toBe(item.id)
        expect(duplicate.repair?.phase).toBe("blocked")
        expect((yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))?.owned).toBe(false)
      }
    }),
  30_000,
)

it.live("direct repair observation survives missing intake storage without exposing ownership", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const item = yield* instance(directory, (backlog) =>
      backlog.create({ description: "Intake disappears during retention race" }),
    )
    const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
    yield* instance(directory, (backlog) =>
      backlog.advance(item.id, { token: claim.token!, revision: 0, phase: "session_creating" }),
    )
    yield* instance(directory, (_, storage) => storage.remove(["raya", "self-heal", "item", item.id]))
    expect(yield* instance(directory, (backlog) => backlog.get(item.id))).toBeUndefined()
    const retained = yield* instance(directory, (backlog) => backlog.outcome(item.id))
    expect(retained?.id).toBe(claim.outcome.id)
    expect(retained?.itemID).toBe(item.id)
    expect(retained?.phase).toBe("session_creating")
    expect(JSON.stringify(retained)).not.toContain(claim.token!)
  }),
)

it.live("listing tolerates an item removed by another Storage instance after enumeration", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const item = yield* instance(directory, (backlog) =>
      backlog.create({ description: "Concurrent retention removes the row" }),
    )
    const rows = yield* Effect.gen(function* () {
      const other = yield* Storage.Service
      return yield* instance(directory, (_, storage) =>
        RayaSelfHeal.make({
          ...storage,
          list: (prefix) =>
            storage.list(prefix).pipe(Effect.tap(() => other.remove(["raya", "self-heal", "item", item.id]))),
        }).list(),
      )
    }).pipe(Effect.provide(Storage.layerFromDir(directory)))
    expect(rows).toEqual([])
  }),
)

it.live("report receipts preserve count and determine newest-first backlog ordering", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const older = yield* instance(directory, (backlog) =>
      backlog.create({ description: "Older feedback receives another report" }),
    )
    const newer = yield* instance(directory, (backlog) =>
      backlog.create({ description: "Newer feedback should become second" }),
    )
    yield* instance(directory, (_, storage) =>
      storage.replace(["raya", "self-heal", "item", older.id], { ...older, updatedAt: 1 }),
    )
    yield* instance(directory, (_, storage) =>
      storage.replace(["raya", "self-heal", "item", newer.id], { ...newer, updatedAt: 2 }),
    )
    yield* instance(directory, (backlog) => backlog.create({ description: older.description }))
    const rows = yield* instance(directory, (backlog) => backlog.list())
    expect(rows[0].id).toBe(older.id)
    expect(rows[0].reports).toBe(2)
    expect(rows[0].updatedAt).toBeGreaterThanOrEqual(rows[1].updatedAt)
  }),
)
