import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { RayaGoal } from "@/kilocode/goal"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { verify } from "@/kilocode/self-heal/worktree"
import * as RepairConfig from "@/kilocode/config/repair"
import { checkout, git } from "./fixtures/self-heal-worktree"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await AppRuntime.runPromise(Config.Service.use((service) => service.invalidate()))
})

test("real repair session config reads preserve source through authoritative dispatch", async () => {
  await using tmp = await tmpdir()
  const source = await checkout(path.join(tmp.path, "seed"))
  await fs.mkdir(path.join(source.root, ".kilo", "plugins"), { recursive: true })
  await fs.mkdir(path.join(source.root, ".kilocode"))
  await fs.writeFile(path.join(source.root, ".kilo", "kilo.json"), JSON.stringify({ model: "fixture/retained" }))
  await fs.writeFile(path.join(source.root, ".kilocode", "kilo.json"), "{}")
  await fs.writeFile(path.join(source.root, ".kilo", "plugins", "local.ts"), "export const Local = async () => ({})")
  await git(source.root, ["add", "."])
  await git(source.root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "config",
  ])
  source.commit = await git(source.root, ["rev-parse", "HEAD"])
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const instances = yield* InstanceStore.Service
      const healing = RayaSelfHeal.make(storage, path.join(tmp.path, "managed"))
      const goals = RayaGoal.make({ storage, sessions })
      const item = yield* healing.create({ description: "Verify config preserves managed repair source" })
      const claim = yield* healing.admit(item.id, { source })
      if (!claim?.owned || !claim.token) throw new Error("Expected exclusive repair admission")
      let outcome = yield* healing.prepare(item.id, { token: claim.token, revision: claim.outcome.revision })
      expect(outcome.phase).toBe("worktree_ready")
      if (!outcome.worktree) throw new Error("Expected managed repair checkout")
      const worktree = outcome.worktree
      expect(yield* RepairConfig.setup(storage, yield* FSUtil.Service, worktree.directory)).toBe(false)
      outcome = yield* healing.advance(item.id, {
        token: claim.token,
        revision: outcome.revision,
        phase: "session_creating",
      })
      const session = yield* instances.provide(
        { directory: worktree.directory },
        sessions.create({
          title: "Config preservation regression",
          agent: "code",
          metadata: {
            rayaSelfHealAttempt: outcome.id,
            rayaSelfHealSource: outcome.source,
            rayaSelfHealWorktree: worktree,
          },
        }),
      )
      const config = yield* instances.provide(
        { directory: worktree.directory },
        Config.Service.use((service) => service.get()),
      )
      expect(config.model).toBe("fixture/retained")
      expect(config.plugin?.some((plugin) => JSON.stringify(plugin).includes("local.ts"))).toBe(true)
      yield* instances.provide(
        { directory: worktree.directory },
        Config.Service.use((service) => service.waitForDependencies()),
      )
      outcome = yield* healing.advance(item.id, {
        token: claim.token,
        revision: outcome.revision,
        phase: "session_created",
        sessionID: session.id,
      })
      outcome = yield* healing.advance(item.id, {
        token: claim.token,
        revision: outcome.revision,
        phase: "goal_creating",
      })
      yield* instances.provide(
        { directory: worktree.directory },
        goals.create(session.id, "Preserve config source", undefined, undefined, item.id),
      )
      outcome = yield* healing.advance(item.id, {
        token: claim.token,
        revision: outcome.revision,
        phase: "goal_created",
      })
      expect(yield* Effect.promise(() => git(worktree.directory, ["ls-files", "--others"]))).toBe("")
      expect(yield* Effect.promise(() => git(worktree.directory, ["diff", "--no-ext-diff"]))).toBe("")
      yield* Effect.promise(() => verify(source, worktree))
      outcome = yield* healing.advance(item.id, {
        token: claim.token,
        revision: outcome.revision,
        phase: "dispatching",
      })
      expect(outcome.phase).toBe("dispatching")
      expect(yield* Effect.promise(() => git(worktree.directory, ["ls-files", "--others"]))).toBe("")
      yield* Effect.promise(() => verify(source, worktree))
      for (const dir of [".kilo", ".kilocode"])
        for (const file of [".gitignore", "package.json"])
          expect(yield* Effect.promise(() => Bun.file(path.join(worktree.directory, dir, file)).exists())).toBe(false)
    }),
  )
}, 60_000)

test("an unrelated UUID directory retains ordinary config setup", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, crypto.randomUUID())
  await fs.mkdir(path.join(directory, ".kilo"), { recursive: true })
  await fs.writeFile(path.join(directory, ".kilo", "kilo.json"), JSON.stringify({ model: "fixture/ordinary" }))
  await provideTestInstance({
    directory,
    fn: async () => {
      const config = await AppRuntime.runPromise(Config.Service.use((service) => service.get()))
      expect(config.model).toBe("fixture/ordinary")
    },
  })
  expect(await Bun.file(path.join(directory, ".kilo", ".gitignore")).exists()).toBe(true)
}, 30_000)
