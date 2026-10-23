import { expect } from "bun:test"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
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

const layer = (root: string) =>
  Storage.layerWithDatabase(path.join(root, "storage")).pipe(
    Layer.provideMerge(Layer.fresh(Database.layerFromPath(path.join(root, "queue.sqlite")))),
  )
const physical = (root: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
    const file = rows.find((row) => row.name === "main")?.file
    expect(file && path.isAbsolute(file)).toBe(true)
    expect(file && path.normalize(file)).toBe(path.join(root, "queue.sqlite"))
  })

it.live(
  "strict v2 review metadata participates in native approval revisions and never releases on stale or excess evidence",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        yield* physical(root)
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
      }).pipe(Effect.provide(layer(root)))
    }),
)

it.live("review refuses an enabled worker instead of silently changing its activation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      yield* physical(root)
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
    }).pipe(Effect.provide(layer(root)))
  }),
)

it.live("a real native hold publication failure retains the held generation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      yield* physical(root)
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
      expect(Cause.pretty(exit.cause)).toContain(
        "authorityTarget: Routine authority publication is unavailable or changed",
      )
      yield* Effect.promise(async () => {
        await rm(marker, { recursive: true })
        await rename(retained, marker)
      })
      expect(yield* gate.get()).toMatchObject({ id: saved.id, state: "held" })
    }).pipe(Effect.provide(layer(root)))
  }),
)

it.live(
  "saved model choice inventory is versioned, exact-byte bound and never changes the transfer review or hold",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        yield* physical(root)
        const storage = yield* Storage.Service
        const gate = hold(storage)
        const saved = yield* gate.begin()
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, "restore-review.json"),
            JSON.stringify(
              renderReview({
                bundle: crypto.randomUUID(),
                hold: saved.id,
                mapping: new Map(),
                storesAt: 1,
                primaries: [],
              }),
            ),
          ),
        )
        const review = destinationReview({ storage, data: root, workers: () => Effect.succeed([]) })
        const first = yield* review.summary()
        if (!("revision" in first)) throw new Error("Expected held review")
        expect(first).toMatchObject({ state: "held", choices: { version: 1, state: "absent" } })
        const profile = {
          format: "raya.profile-preferences" as const,
          version: 1 as const,
          reviewOnly: true as const,
          activation: "held" as const,
          config: {
            model: { providerID: "local", modelID: "missing-default" },
            smallModel: { providerID: "local", modelID: "small" },
            defaultAgent: "general",
          },
          modelState: {
            models: [{ agent: "general", providerID: "local", modelID: "selected" }],
            recent: [],
            favorite: [],
          },
          extensionState: {
            recentModels: [{ providerID: "local", modelID: "recent" }],
            favoriteModels: [{ providerID: "local", modelID: "favorite" }],
            variants: [
              { providerID: "local", modelID: "selected", variant: "low" },
              { agent: "general", providerID: "local", modelID: "selected", variant: "" },
            ],
            expanded: false,
          },
        }
        const id = crypto.randomUUID()
        const owner = crypto.randomUUID()
        const models = {
          selected: { providerID: "local", modelID: "captured" },
          recent: [],
          favorite: [],
          agents: [{ agent: "code", providerID: "local", modelID: "unavailable-preserved" }],
          variants: [
            { providerID: "local", modelID: "captured", variant: "high" },
            { agent: "code", providerID: "local", modelID: "captured", variant: "" },
          ],
          expanded: true,
        }
        const cli = { ...models, variants: [{ providerID: "local", modelID: "captured", variant: "" }] }
        const host = {
          format: "raya.host-capsule",
          version: 1,
          hosts: [
            {
              id,
              role: "view",
              revision: 2,
              models,
              owners: [
                { id: owner, revision: 3, root: { kind: "json", path: path.join(root, "source-state") }, models: cli },
              ],
              contexts: [{ id: crypto.randomUUID(), path: path.join(root, "source-workspace") }],
            },
          ],
        }
        yield* Effect.promise(() => writeFile(path.join(root, "restore-preferences.json"), JSON.stringify(profile)))
        const single = yield* review.summary()
        if (!("choices" in single) || single.choices?.state !== "ready") throw new Error("Expected profile choices")
        expect(single.choices.sources).toEqual([{ kind: "profile", preferences: profile }])
        expect(single.revision).toBe(first.revision)
        yield* Effect.promise(() => writeFile(path.join(root, "restore-host.json"), JSON.stringify(host)))
        const second = yield* review.summary()
        if (!("choices" in second) || second.choices?.state !== "ready") throw new Error("Expected saved choices")
        expect(second.revision).toBe(first.revision)
        expect(second.choices.revision).not.toBe(single.choices.revision)
        expect(second.choices.sources).toEqual([
          { kind: "profile", preferences: profile },
          { kind: "host", id, role: "view", revision: 2, models, owners: [{ id: owner, revision: 3, models: cli }] },
        ])
        expect(JSON.stringify(second.choices)).not.toContain("source-state")
        expect(JSON.stringify(second.choices)).not.toContain("source-workspace")
        yield* Effect.promise(() =>
          writeFile(path.join(root, "restore-preferences.json"), JSON.stringify(profile) + "\n"),
        )
        const third = yield* review.summary()
        if (!("choices" in third) || third.choices?.state !== "ready") throw new Error("Expected refreshed choices")
        expect(third.revision).toBe(first.revision)
        expect(third.choices.revision).not.toBe(second.choices.revision)
        expect(third.choices.sources).toEqual(second.choices.sources)
        yield* Effect.promise(() => writeFile(path.join(root, "restore-host.json"), JSON.stringify(host) + "\n"))
        const fourth = yield* review.summary()
        if (!("choices" in fourth) || fourth.choices?.state !== "ready") throw new Error("Expected host-byte refresh")
        expect(fourth.choices.revision).not.toBe(third.choices.revision)
        expect(fourth.choices.sources).toEqual(third.choices.sources)
        yield* Effect.promise(() => rm(path.join(root, "restore-preferences.json")))
        const sole = yield* review.summary()
        if (!("choices" in sole) || sole.choices?.state !== "ready") throw new Error("Expected host-only choices")
        expect(sole.choices.sources).toHaveLength(1)
        expect(sole.choices.sources[0]).toMatchObject({ kind: "host", id })
        expect(sole.choices.revision).not.toBe(fourth.choices.revision)
        for (const hosts of [
          [host.hosts[0], host.hosts[0]],
          [{ ...host.hosts[0], owners: [host.hosts[0].owners[0], host.hosts[0].owners[0]] }],
          [{ ...host.hosts[0], models: { ...models, agents: [models.agents[0], models.agents[0]] } }],
          [
            {
              ...host.hosts[0],
              owners: [{ ...host.hosts[0].owners[0], models: { ...cli, agents: [cli.agents[0], cli.agents[0]] } }],
            },
          ],
          [{ ...host.hosts[0], models: { ...models, variants: [models.variants[1], models.variants[1]] } }],
          [
            {
              ...host.hosts[0],
              owners: [
                { ...host.hosts[0].owners[0], models: { ...cli, variants: [cli.variants[0], cli.variants[0]] } },
              ],
            },
          ],
          [
            {
              ...host.hosts[0],
              owners: [{ ...host.hosts[0].owners[0], models: { ...cli, variants: [models.variants[1]] } }],
            },
          ],
        ]) {
          yield* Effect.promise(() =>
            writeFile(path.join(root, "restore-host.json"), JSON.stringify({ ...host, hosts })),
          )
          const invalid = yield* review.summary()
          expect(invalid).toMatchObject({ state: "held", revision: first.revision, choices: { state: "unavailable" } })
          expect(yield* gate.get()).toEqual(saved)
        }
        yield* Effect.promise(() => writeFile(path.join(root, "restore-host.json"), JSON.stringify(host)))
        const restored = yield* review.summary()
        if (!("choices" in restored) || restored.choices?.state !== "ready")
          throw new Error("Expected restored host choices")
        yield* Effect.promise(() => rm(path.join(root, "restore-host.json")))
        expect(yield* review.summary()).toMatchObject({ revision: first.revision, choices: { state: "absent" } })
        expect(yield* gate.get()).toEqual(saved)
        yield* storage.replace(["raya", "restore-hold"], { ...saved, id: crypto.randomUUID() })
        const changed = yield* review.summary().pipe(Effect.exit)
        expect(Exit.isFailure(changed)).toBe(true)
      }).pipe(Effect.provide(layer(root)))
    }),
)

it.live(
  "corrupt or unsafe saved choices remain visibly unavailable while legacy review approval stays independent",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        yield* physical(root)
        const storage = yield* Storage.Service
        const gate = hold(storage)
        const saved = yield* gate.begin()
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, "restore-review.json"),
            JSON.stringify(
              renderReview({
                bundle: crypto.randomUUID(),
                hold: saved.id,
                mapping: new Map(),
                storesAt: 1,
                primaries: [],
              }),
            ),
          ),
        )
        const review = destinationReview({ storage, data: root, workers: () => Effect.succeed([]) })
        const first = yield* review.summary()
        if (!("revision" in first) || !first.revision) throw new Error("Expected transfer review")
        const file = path.join(root, "restore-preferences.json")
        for (const value of ["not-json", JSON.stringify({ credentials: "never expose this" }), " ".repeat(1_048_577)]) {
          yield* Effect.promise(() => writeFile(file, value))
          const current = yield* review.summary()
          expect(current).toMatchObject({
            state: "held",
            revision: first.revision,
            choices: {
              version: 1,
              state: "unavailable",
              error: "Saved model choices are unavailable. Repair the saved evidence before applying choices.",
            },
          })
          expect(JSON.stringify(current)).not.toContain("never expose this")
          expect(yield* gate.get()).toEqual(saved)
        }
        yield* Effect.promise(() => rm(file))
        yield* Effect.promise(() => mkdir(file))
        expect(yield* review.summary()).toMatchObject({ choices: { state: "unavailable" } })
        expect(yield* gate.get()).toEqual(saved)
        const approved = yield* review.approve({
          id: saved.id,
          revision: first.revision,
          reviewed: true,
          workspacesAcknowledged: true,
          reconnectAcknowledged: true,
        })
        expect(approved.state).toBe("released")
        expect(approved).toMatchObject({ choices: { state: "unavailable" } })
        expect(approved.workers).toEqual([])
      }).pipe(Effect.provide(layer(root)))
    }),
)
