// raya_change - verify the durable global self-healing backlog
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node])))

describe("RayaSelfHeal", () => {
  it.live("classifies, persists, deduplicates, and updates feedback", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      const description = `The goal loops after raw tool markup ${crypto.randomUUID()}`
      const created = yield* backlog.create({ description })
      yield* Effect.addFinalizer(() => storage.remove(["raya", "self-heal", "item", created.id]).pipe(Effect.orDie))

      expect(created.category).toBe("goal")
      expect(created.severity).toBe("high")
      expect(created.status).toBe("triaged")
      expect(created.explanation).toContain("globally visible")

      const duplicate = yield* backlog.create({ description })
      expect(duplicate.id).toBe(created.id)
      expect(duplicate.reports).toBe(2)
      expect((yield* backlog.list()).some((item) => item.id === created.id)).toBe(true)

      const queued = yield* backlog.update(created.id, { status: "queued" })
      expect(queued?.status).toBe("queued")
      expect((yield* backlog.get(created.id))?.status).toBe("queued")
    }),
  )

  it.live("prunes month-old terminal feedback but preserves unresolved work", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      const done = yield* backlog.create({ description: `Verified visual defect ${crypto.randomUUID()}` })
      const blocked = yield* backlog.create({ description: `Blocked runtime defect ${crypto.randomUUID()}` })
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000
      const doneKey = ["raya", "self-heal", "item", done.id]
      const blockedKey = ["raya", "self-heal", "item", blocked.id]
      yield* Effect.addFinalizer(() =>
        Effect.all([storage.remove(doneKey).pipe(Effect.ignore), storage.remove(blockedKey).pipe(Effect.ignore)]).pipe(
          Effect.asVoid,
        ),
      )
      yield* storage.write(doneKey, { ...done, status: "verified", updatedAt: old }).pipe(Effect.orDie)
      yield* storage.write(blockedKey, { ...blocked, status: "blocked", updatedAt: old }).pipe(Effect.orDie)

      expect(yield* backlog.get(done.id)).toBeUndefined()
      expect((yield* backlog.list()).some((item) => item.id === blocked.id)).toBe(true)
    }),
  )

  it.live("keeps only the newest fifty evidence records", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      const item = yield* backlog.create({ description: `Evidence retention defect ${crypto.randomUUID()}` })
      yield* Effect.addFinalizer(() =>
        storage.remove(["raya", "self-heal", "item", item.id]).pipe(Effect.ignore, Effect.asVoid),
      )
      const evidence = Array.from({ length: 60 }, (_, index) => ({ summary: `Evidence ${index}`, at: index }))

      const updated = yield* backlog.update(item.id, { evidence })
      expect(updated?.evidence).toHaveLength(50)
      expect(updated?.evidence[0]?.summary).toBe("Evidence 10")
      expect(updated?.evidence.at(-1)?.summary).toBe("Evidence 59")
    }),
  )
})
