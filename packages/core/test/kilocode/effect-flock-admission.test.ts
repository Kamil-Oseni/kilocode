import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { Global } from "../../src/global"
import { RepositoryAdmission } from "../../src/kilocode/repository-admission"
import { EffectFlock } from "../../src/util/effect-flock"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

for (const mode of ["absent", "replaced", "redirected"] as const)
  test(`authentic repository admission refuses an ${mode} lock namespace before acquiring or recreating it`, async () => {
    await using tmp = await tmpdir()
    const repos = path.join(tmp.path, "repos")
    const state = path.join(tmp.path, "state")
    const dir = path.join(state, "locks")
    const retained = path.join(state, "retained-locks")
    const target = path.join(tmp.path, "redirect-target")
    const key = "repository-admission-root-identity"
    const lock = path.join(dir, Hash.fast(key) + ".lock")
    await fs.mkdir(repos)
    await fs.mkdir(state)
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, "preserved.txt"), "Unrelated target remains unchanged.\n", { flag: "wx" })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith({ state })]])
    const controller = RepositoryAdmission.make(() => undefined)
    const observation = { entered: 0, refused: false }
    const failures: unknown[] = []
    const pins: Array<{ dev: bigint; ino: bigint }> = []

    const result = await Effect.runPromise(
      RepositoryAdmission.provide(
        controller,
        controller
          .run(
            { repos, state, target: path.join(repos, "checkout") },
            Effect.gen(function* () {
              const flock = yield* EffectFlock.Service
              // The same real service has already ensured and released this root.
              yield* Effect.scoped(flock.acquire(key))
              yield* Effect.promise(async () => {
                const info = await fs.lstat(dir, { bigint: true })
                expect(info.isDirectory()).toBe(true)
                expect(info.isSymbolicLink()).toBe(false)
                pins.push({ dev: info.dev, ino: info.ino })
                expect(await fs.readdir(dir)).toEqual([])
                await fs.rename(dir, retained)
                if (mode === "replaced") await fs.mkdir(dir)
                if (mode === "redirected")
                  await fs.symlink(target, dir, process.platform === "win32" ? "junction" : "dir")
              })
              const attempt = yield* flock
                .withLock(
                  Effect.sync(() => {
                    observation.entered++
                  }),
                  key,
                )
                .pipe(Effect.exit)
              observation.refused = Exit.isFailure(attempt)
              if (Exit.isFailure(attempt)) failures.push(Cause.squash(attempt.cause))
            }),
          )
          .pipe(Effect.provide(layer), Effect.exit),
      ),
    )

    expect(observation.refused).toBe(true)
    expect(observation.entered).toBe(0)
    expect(failures).toHaveLength(1)
    // Release must independently retain the original physical-pin mismatch.
    expect(Exit.isFailure(result)).toBe(true)
    expect(controller.snapshot().active).toBe(0)
    expect(controller.snapshot().failures).toBeGreaterThan(0)
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(controller.drain)))).toBe(true)
    const original = await fs.lstat(retained, { bigint: true })
    expect({ dev: original.dev, ino: original.ino }).toEqual(pins[0])
    expect(original.isDirectory()).toBe(true)
    expect(original.isSymbolicLink()).toBe(false)
    expect(await fs.readdir(retained)).toEqual([])
    expect(await fs.readdir(target)).toEqual(["preserved.txt"])
    expect(await fs.readFile(path.join(target, "preserved.txt"), "utf8")).toBe("Unrelated target remains unchanged.\n")
    if (mode === "absent") {
      const current = await fs.lstat(dir).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
        throw err
      })
      expect(current).toBeUndefined()
    }
    if (mode === "replaced") {
      const current = await fs.lstat(dir, { bigint: true })
      expect(current.isDirectory()).toBe(true)
      expect(current.isSymbolicLink()).toBe(false)
      expect({ dev: current.dev, ino: current.ino }).not.toEqual(pins[0])
      expect(await fs.readdir(dir)).toEqual([])
    }
    if (mode === "redirected") {
      expect((await fs.lstat(dir)).isSymbolicLink()).toBe(true)
      expect(await fs.realpath(dir)).toBe(await fs.realpath(target))
    }
    expect(await Bun.file(path.join(lock, "meta.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(lock, "heartbeat")).exists()).toBe(false)
  }, 30_000)
