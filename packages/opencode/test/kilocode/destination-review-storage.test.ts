import { expect } from "bun:test"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { destinationReview } from "@/kilocode/migration/destination-review"
import { hold } from "@/kilocode/task/hold"
import { RayaTask } from "@/kilocode/task"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { renderReview } from "@/kilocode/migration/profile-restore-review-schema"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

it.live(
  "strict v2 review metadata participates in native approval revisions and never releases on stale or excess evidence",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const gate = hold(storage)
        const saved = yield* gate.begin()
        const file = path.join(root, "restore-review.json")
        const value = renderReview({
          bundle: crypto.randomUUID(),
          hold: saved.id,
          mapping: new Map([[root, root]]),
          storesAt: 1,
          primaries: [],
        })
        yield* Effect.promise(() => writeFile(file, JSON.stringify(value)))
        const review = destinationReview({ storage, data: root, workers: () => Effect.succeed([]) })
        const first = yield* review.summary()
        if (!("revision" in first)) throw new Error("Expected v2 review revision")
        yield* Effect.promise(() => writeFile(file, JSON.stringify({ ...value, storesAt: 2 })))
        const second = yield* review.summary()
        if (!("revision" in second)) throw new Error("Expected updated v2 review revision")
        expect(first.revision).not.toBe(second.revision)
        const approval = {
          id: saved.id,
          revision: first.revision,
          reviewed: true as const,
          workspacesAcknowledged: true as const,
          reconnectAcknowledged: true as const,
        }
        const stale = yield* review.approve(approval).pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect(yield* gate.get()).toMatchObject({ state: "held", id: saved.id })
        yield* Effect.promise(() => writeFile(file, JSON.stringify({ ...value, storesAt: 2, authorization: true })))
        expect(Exit.isFailure(yield* review.summary().pipe(Effect.exit))).toBe(true)
        expect(yield* gate.get()).toMatchObject({ state: "held", id: saved.id })
        yield* Effect.promise(() => writeFile(file, JSON.stringify({ ...value, storesAt: 2 })))
        expect(yield* review.approve({ ...approval, revision: second.revision })).toMatchObject({ state: "released" })
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
)

it.live("review refuses an enabled worker instead of silently changing its activation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      const worker = yield* tasks.create({
        name: "Unpaused imported worker",
        objective: "Retain activation",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const saved = yield* hold(storage).begin()
      yield* Effect.promise(() =>
        writeFile(
          path.join(root, "restore-review.json"),
          JSON.stringify({
            format: "raya.restore-review",
            version: 1,
            bundle: crypto.randomUUID(),
            hold: saved.id,
            workspaces: {},
            reconnectCredentials: true,
            uncertainWork: "held-no-replay",
          }),
        ),
      )
      const review = destinationReview({ storage, data: root, workers: tasks.list })
      const summary = yield* review.summary()
      if (!("revision" in summary)) throw new Error("Expected held review")
      const exit = yield* review
        .approve({
          id: saved.id,
          revision: summary.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("An enabled worker was unexpectedly approved")
      expect(Cause.pretty(exit.cause)).toContain("Pause every transferred worker")
      expect(yield* tasks.get(worker.id)).toMatchObject({ enabled: true })
      expect(yield* hold(storage).get()).toMatchObject({ state: "held", id: saved.id })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("a real native hold publication failure retains the held generation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const marker = path.join(root, "storage", "raya", "restore-hold.json")
      const retained = marker + ".retained"
      const gate = hold(storage)
      const saved = yield* gate.begin()
      yield* Effect.promise(() =>
        writeFile(
          path.join(root, "restore-review.json"),
          JSON.stringify({
            format: "raya.restore-review",
            version: 1,
            bundle: crypto.randomUUID(),
            hold: saved.id,
            workspaces: {},
            reconnectCredentials: true,
            uncertainWork: "held-no-replay",
          }),
        ),
      )
      // Inject a real directory collision immediately before the original native
      // replace. The production Storage implementation still performs publication.
      const broken: Storage.Interface = {
        ...storage,
        replace: (key, value) =>
          Effect.gen(function* () {
            if (key.join("/") === "raya/restore-hold") {
              yield* Effect.promise(() => rename(marker, retained))
              yield* Effect.promise(() => mkdir(marker))
            }
            return yield* storage.replace(key, value)
          }),
      }
      const review = destinationReview({ storage: broken, data: root, workers: () => Effect.succeed([]) })
      const summary = yield* review.summary()
      if (!("revision" in summary)) throw new Error("Expected held review evidence")
      const exit = yield* review
        .approve({
          id: saved.id,
          revision: summary.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("Native publication unexpectedly succeeded")
      expect(Cause.pretty(exit.cause)).toMatch(/EISDIR|EPERM|EACCES|directory/i)
      yield* Effect.promise(async () => {
        await rm(marker, { recursive: true })
        await rename(retained, marker)
      })
      expect(yield* gate.get()).toMatchObject({ id: saved.id, state: "held" })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
