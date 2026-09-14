// raya_change - verify the durable global self-healing backlog
import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { createHash } from "node:crypto"
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
      yield* storage.write(doneKey, { ...done, status: "cancelled", updatedAt: old }).pipe(Effect.orDie)
      yield* storage.write(blockedKey, { ...blocked, status: "blocked", updatedAt: old }).pipe(Effect.orDie)

      expect(yield* backlog.get(done.id)).toBeUndefined()
      expect((yield* backlog.list()).some((item) => item.id === blocked.id)).toBe(true)
    }),
  )

  it.live("lets the repair agent refine classification and flag duplicates via update", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      // Keyword triage lands this as "goal"/"high"; the model can sharpen it later.
      const item = yield* backlog.create({ description: `The goal loops forever ${crypto.randomUUID()}` })
      const canonical = yield* backlog.create({ description: `Unrelated browser scroll defect ${crypto.randomUUID()}` })
      yield* Effect.addFinalizer(() =>
        Effect.all([
          storage.remove(["raya", "self-heal", "item", item.id]).pipe(Effect.ignore),
          storage.remove(["raya", "self-heal", "item", canonical.id]).pipe(Effect.ignore),
        ]).pipe(Effect.asVoid),
      )
      expect(item.category).toBe("goal")

      const refined = yield* backlog.update(item.id, {
        category: "ui",
        severity: "low",
        approach: "Repair the shared visual primitive and compare screenshots.",
        title: "Refined title",
        classifiedBy: "model",
      })
      expect(refined?.category).toBe("ui")
      expect(refined?.severity).toBe("low")
      expect(refined?.title).toBe("Refined title")
      expect(refined?.classifiedBy).toBe("model")
      // Reclassification must not disturb the fingerprint used for intake dedupe.
      expect(refined?.fingerprint).toBe(item.fingerprint)

      const marked = yield* backlog.update(item.id, { status: "duplicate", duplicateOf: canonical.id })
      expect(marked?.status).toBe("duplicate")
      expect(marked?.duplicateOf).toBe(canonical.id)
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

  it.live("appends one immutable verification receipt without losing concurrent evidence", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      const item = yield* backlog.create({ description: `Concurrent verification publication ${crypto.randomUUID()}` })
      const installationID = crypto.randomUUID()
      const revision = `goal_${crypto.randomUUID()}`
      const publication = [
        "raya",
        "self-heal",
        "publication",
        createHash("sha256").update(item.id).digest("hex"),
        createHash("sha256")
          .update(JSON.stringify([installationID, revision]))
          .digest("hex"),
      ]
      yield* Effect.addFinalizer(() =>
        Effect.all([
          storage.remove(["raya", "self-heal", "item", item.id]).pipe(Effect.ignore),
          storage.remove(publication).pipe(Effect.ignore),
        ]).pipe(Effect.asVoid),
      )
      yield* backlog.update(item.id, {
        evidence: Array.from({ length: 48 }, (_, index) => ({ summary: `Earlier evidence ${index}`, at: index })),
      })
      const input = {
        installationID,
        verification: {
          sessionID: `ses_${crypto.randomUUID()}`,
          goalRevision: revision,
          summary: "The installed repair passed its accepted audit.",
          verifiedAt: 100,
          reviewedAt: 101,
          requirements: [
            {
              requirement: "The original failure no longer reproduces.",
              passed: true as const,
              evidence: [
                {
                  sessionID: `ses_${crypto.randomUUID()}`,
                  messageID: `msg_${crypto.randomUUID()}`,
                  partID: `prt_${crypto.randomUUID()}`,
                  callID: `call_${crypto.randomUUID()}`,
                  summary: "The runtime reproduction passed.",
                  record: { version: 1 as const, digest: "a".repeat(64), at: 99 },
                },
              ],
            },
          ],
        },
      }
      const diagnostic = {
        summary: "A concurrent diagnostic was retained.",
        artifact: "diagnostic:concurrent",
        at: 102,
      }
      const [receipt] = yield* Effect.all(
        [backlog.publish(item.id, input), backlog.update(item.id, { evidence: [diagnostic] })],
        { concurrency: "unbounded" },
      )
      const observed = yield* backlog.get(item.id)
      expect(observed?.evidence).toHaveLength(50)
      expect(observed?.evidence).toContainEqual(diagnostic)
      expect(observed?.evidence).toContainEqual(receipt.evidence)
      expect(yield* backlog.publish(item.id, input)).toEqual(receipt)
      yield* backlog.update(item.id, {
        evidence: Array.from({ length: 60 }, (_, index) => ({ summary: `Later evidence ${index}`, at: 200 + index })),
      })
      const bounded = yield* backlog.get(item.id)
      expect(bounded?.evidence).toHaveLength(50)
      expect(bounded?.evidence).toContainEqual(receipt.evidence)

      const conflict = yield* backlog
        .publish(item.id, {
          ...input,
          verification: { ...input.verification, summary: "Changed verification content." },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      const missing = yield* backlog.publish(`heal_missing_${crypto.randomUUID()}`, input).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )
})
