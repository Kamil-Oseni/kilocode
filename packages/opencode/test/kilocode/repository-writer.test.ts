import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { RepositoryAdmission } from "@opencode-ai/core/kilocode/repository-admission"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { tmpdir } from "../fixture/fixture"

test("repository producer count spans gate, scoped finalizer and retirement", async () => {
  await using tmp = await tmpdir()
  const id = "profile.data.repos"
  const registry = ProfileWriterRegistry.make([id])
  const controller = RepositoryAdmission.make(() => undefined)
  controller.install(() => {
    if (!Effect.runSync(registry.snapshot).registered.includes(id)) Effect.runSync(registry.register(id))
    return ProfileWriterLive.from(registry, id)
  })
  const scope = Effect.runSync(Scope.make())
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const cleanup = Deferred.makeUnsafe<void>()
  const cleaned = Deferred.makeUnsafe<void>()
  const held = coordinateNativeRoots([{ kind: "json", path: path.join(tmp.path, "repos") }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  await Effect.runPromise(Deferred.await(entered))
  const fiber = await Effect.runPromise(
    controller.fork(
      controller.run(
        {
          repos: path.join(tmp.path, "repos"),
          state: path.join(tmp.path, "state"),
          target: path.join(tmp.path, "repos", "checkout"),
        },
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
            )
          }),
        ),
      ),
      scope,
    ),
  )
  expect(controller.snapshot().active).toBe(1)
  expect(Effect.runSync(registry.snapshot).active).toEqual([{ id, count: 1 }])
  let settled = false
  const drain = Effect.runPromise(controller.drain).then(() => {
    settled = true
  })
  const late = await Effect.runPromise(Effect.exit(controller.fork(Effect.void, scope)))
  expect(Exit.isFailure(late)).toBe(true)
  await Bun.sleep(50)
  expect(settled).toBe(false)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await held
  await Effect.runPromise(Deferred.await(cleanup))
  expect(controller.snapshot().active).toBe(1)
  expect(Effect.runSync(registry.snapshot).active).toEqual([{ id, count: 1 }])
  expect(settled).toBe(false)
  await Effect.runPromise(Deferred.succeed(cleaned, undefined))
  await Effect.runPromise(Fiber.join(fiber))
  await drain
  expect(Effect.runSync(registry.snapshot).active).toEqual([])
  await Effect.runPromise(Scope.close(scope, Exit.void))
}, 30_000)

test("a swallowed compatibility failure stays sticky only after genuine admitted work", async () => {
  await using tmp = await tmpdir()
  const controller = RepositoryAdmission.make(() => undefined)
  const scope = Effect.runSync(Scope.make())
  const original = new Error("original repository child failure")
  const child = await Effect.runPromise(
    controller.fork(
      controller
        .run(
          {
            repos: path.join(tmp.path, "repos"),
            state: path.join(tmp.path, "state"),
            target: path.join(tmp.path, "repos", "checkout"),
          },
          Effect.fail(original),
        )
        .pipe(Effect.catchCause(() => Effect.void)),
      scope,
    ),
  )
  await Effect.runPromise(Fiber.join(child))
  const result = await Effect.runPromise(Effect.exit(controller.drain))
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(original)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("already closed scopes settle reserved repository producers", async () => {
  const controller = RepositoryAdmission.make(() => undefined)
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(Scope.close(scope, Exit.void))
  let entered = false
  const result = await Effect.runPromise(
    Effect.exit(
      controller.fork(
        Effect.sync(() => {
          entered = true
        }),
        scope,
      ),
    ),
  )
  if (Exit.isSuccess(result)) await Effect.runPromise(Fiber.await(result.value))
  expect(entered).toBe(false)
  await Effect.runPromise(controller.drain.pipe(Effect.timeout("2 seconds")))
  expect(controller.snapshot().active).toBe(0)
})
