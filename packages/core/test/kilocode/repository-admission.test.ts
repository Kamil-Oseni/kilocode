import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Deferred, Effect, Exit } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { Database } from "../../src/database/database"
import { Global } from "../../src/global"
import { Reference } from "../../src/reference"
import { Repository } from "../../src/repository"
import { RepositoryCache } from "../../src/repository-cache"
import { RepositoryAdmission } from "../../src/kilocode/repository-admission"
import { coordinateProfileWriters } from "../../src/kilocode/profile-maintenance"
import { gitRemote } from "../fixture/git"
import { tmpdir } from "../fixture/tmpdir"

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function errors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errors) : [error]
}

async function gate(root: string, file: string) {
  const ready = signal()
  const stop = signal()
  const done = coordinateProfileWriters(
    {
      version: 1,
      id: "repository-real-gate",
      roots: [
        { kind: "json", path: file },
        { kind: "sqlite", path: path.join(root, "gate.db") },
      ],
    },
    "cooperative-maintenance",
    async () => {
      ready.resolve()
      await stop.promise
    },
  )
  await ready.promise
  return {
    release: async () => {
      stop.resolve()
      await done
    },
  }
}

function layer(root: string) {
  return AppNodeBuilder.build(RepositoryCache.node, [
    [
      Global.node,
      Global.layerWith({
        repos: path.join(root, "repos"),
        state: path.join(root, "state"),
        data: path.join(root, "data"),
      }),
    ],
  ])
}

test("cache waits for real maintenance and retirement joins accepted work", async () => {
  await using tmp = await tmpdir()
  const remote = await gitRemote(tmp.path)
  const controller = RepositoryAdmission.make(() => undefined)
  const ready = signal()
  const start = Deferred.makeUnsafe<void>()
  const file = path.join(Repository.cachePath(path.join(tmp.path, "repos"), remote.reference), "README.md")
  let settled = false
  const work = Effect.runPromise(
    RepositoryAdmission.provide(
      controller,
      Effect.gen(function* () {
        const service = yield* RepositoryCache.Service
        ready.resolve()
        yield* Deferred.await(start)
        return yield* service.ensure({ reference: remote.reference })
      }).pipe(Effect.provide(layer(tmp.path))),
    ),
  ).then((value) => {
    settled = true
    return value
  })
  await ready.promise
  const held = await gate(tmp.path, path.join(tmp.path, "repos"))
  await Effect.runPromise(Deferred.succeed(start, undefined))
  await Bun.sleep(100)
  expect(controller.snapshot().active).toBe(1)
  expect(settled).toBe(false)
  expect(await Bun.file(file).exists()).toBe(false)
  let closed = false
  const drain = Effect.runPromise(controller.drain).then(() => {
    closed = true
  })
  const late = await Effect.runPromise(
    Effect.exit(
      controller.run(
        { repos: path.join(tmp.path, "repos"), state: path.join(tmp.path, "state"), target: path.dirname(file) },
        Effect.void,
      ),
    ),
  )
  expect(Exit.isFailure(late)).toBe(true)
  await Bun.sleep(100)
  expect(closed).toBe(false)
  await held.release()
  expect((await work).status).toBe("cloned")
  await drain
  expect((await fs.readFile(file, "utf8")).trim()).toBe("one")
  expect(controller.snapshot()).toEqual({ closing: true, active: 0, failures: 0 })
}, 30_000)

test("real checkout and state-lock gates independently exclude cache effects", async () => {
  for (const key of ["checkout", "locks"]) {
    await using tmp = await tmpdir()
    const remote = await gitRemote(tmp.path)
    const controller = RepositoryAdmission.make(() => undefined)
    const ready = signal()
    const start = Deferred.makeUnsafe<void>()
    const target = Repository.cachePath(path.join(tmp.path, "repos"), remote.reference)
    const work = Effect.runPromise(
      RepositoryAdmission.provide(
        controller,
        Effect.gen(function* () {
          const service = yield* RepositoryCache.Service
          ready.resolve()
          yield* Deferred.await(start)
          return yield* service.ensure({ reference: remote.reference })
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    )
    await ready.promise
    const held = await gate(tmp.path, key === "checkout" ? target : path.join(tmp.path, "state", "locks"))
    await Effect.runPromise(Deferred.succeed(start, undefined))
    await Bun.sleep(100)
    expect(controller.snapshot().active).toBe(1)
    expect(await Bun.file(path.join(target, "README.md")).exists()).toBe(false)
    await held.release()
    expect((await work).status).toBe("cloned")
    await Effect.runPromise(controller.drain)
  }
}, 30_000)

test("canonical checkout escape is a safe refusal before admission effects", async () => {
  await using tmp = await tmpdir()
  const repos = path.join(tmp.path, "repos")
  const outside = path.join(tmp.path, "outside")
  await fs.mkdir(repos)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, "retained"), "unchanged")
  await fs.symlink(outside, path.join(repos, "alias"), process.platform === "win32" ? "junction" : "dir")
  const controller = RepositoryAdmission.make(() => undefined)
  let body = false
  const result = await Effect.runPromise(
    Effect.exit(
      controller.run(
        { repos, state: path.join(tmp.path, "state"), target: path.join(repos, "alias", "checkout") },
        Effect.sync(() => {
          body = true
        }),
      ),
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(body).toBe(false)
  expect(controller.snapshot().failures).toBe(0)
  expect(await Bun.file(path.join(outside, "retained")).text()).toBe("unchanged")
  expect(await fs.readdir(repos)).toEqual(["alias"])
  await Effect.runPromise(controller.drain)
})

test("actual Reference producer is reserved before return and drained with real Git", async () => {
  await using tmp = await tmpdir()
  const remote = await gitRemote(tmp.path)
  await fs.mkdir(path.join(tmp.path, "owner"))
  await fs.rename(path.join(tmp.path, "origin.git"), path.join(tmp.path, "owner", "repo.git"))
  const previous = process.env.KILO_REPO_CLONE_GITHUB_BASE_URL
  process.env.KILO_REPO_CLONE_GITHUB_BASE_URL = pathToFileURL(tmp.path).href + "/"
  const controller = RepositoryAdmission.make(() => undefined)
  const ready = signal()
  const booted = signal()
  const start = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const graph = AppNodeBuilder.build(Reference.node, [
    [
      Global.node,
      Global.layerWith({
        repos: path.join(tmp.path, "repos"),
        state: path.join(tmp.path, "state"),
        data: path.join(tmp.path, "data"),
      }),
    ],
    [Database.node, Database.layerFromPath(path.join(tmp.path, "events.db"))],
  ])
  const work = Effect.runPromise(
    RepositoryAdmission.provide(
      controller,
      Effect.gen(function* () {
        const service = yield* Reference.Service
        booted.resolve()
        yield* Deferred.await(start)
        yield* service.replace([
          ["docs", Reference.GitSource.make({ type: "git", repository: "owner/repo", branch: "main" })],
        ])
        ready.resolve()
        yield* Deferred.await(release)
      }).pipe(Effect.scoped, Effect.provide(graph)),
    ),
  )
  await booted.promise
  const held = await gate(tmp.path, path.join(tmp.path, "repos"))
  await Effect.runPromise(Deferred.succeed(start, undefined))
  try {
    await ready.promise
    expect(controller.snapshot().active).toBe(1)
    const file = path.join(Repository.cachePath(path.join(tmp.path, "repos"), remote.reference, "main"), "README.md")
    expect(await Bun.file(file).exists()).toBe(false)
    let settled = false
    const drain = Effect.runPromise(controller.drain).then(() => {
      settled = true
    })
    await Bun.sleep(100)
    expect(settled).toBe(false)
    await held.release()
    await drain
    expect((await fs.readFile(file, "utf8")).trim()).toBe("one")
    expect(controller.snapshot().active).toBe(0)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await work
    if (previous === undefined) delete process.env.KILO_REPO_CLONE_GITHUB_BASE_URL
    else process.env.KILO_REPO_CLONE_GITHUB_BASE_URL = previous
  }
}, 30_000)

test("pure validation stays safe while genuine clone failure is retained", async () => {
  await using tmp = await tmpdir()
  const remote = await gitRemote(tmp.path)
  const safe = RepositoryAdmission.make(() => undefined)
  const validation = await Effect.runPromise(
    RepositoryAdmission.provide(
      safe,
      Effect.gen(function* () {
        return yield* Effect.exit(
          (yield* RepositoryCache.Service).ensure({ reference: remote.reference, branch: "../unsafe" }),
        )
      }).pipe(Effect.provide(layer(tmp.path))),
    ),
  )
  expect(Exit.isFailure(validation)).toBe(true)
  expect(safe.snapshot().failures).toBe(0)
  await Effect.runPromise(safe.drain)
  const controller = RepositoryAdmission.make(() => undefined)
  const failed = await Effect.runPromise(
    RepositoryAdmission.provide(
      controller,
      Effect.gen(function* () {
        return yield* Effect.exit(
          (yield* RepositoryCache.Service).ensure({
            reference: { ...remote.reference, remote: pathToFileURL(path.join(tmp.path, "missing.git")).href },
          }),
        )
      }).pipe(Effect.provide(layer(tmp.path))),
    ),
  )
  expect(Exit.isFailure(failed)).toBe(true)
  expect(controller.snapshot().failures).toBeGreaterThan(0)
  const drain = await Effect.runPromise(Effect.exit(controller.drain))
  expect(Exit.isFailure(drain)).toBe(true)
  if (Exit.isFailure(drain) && Exit.isFailure(failed)) {
    const retained = errors(Cause.squash(drain.cause))
    expect(retained).toContain(Cause.squash(failed.cause))
    expect(retained.length).toBeGreaterThan(1)
  }
}, 30_000)

test("real namespace replacement and original body failure both survive cleanup", async () => {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, "repos"))
  await fs.mkdir(path.join(tmp.path, "state"))
  const controller = RepositoryAdmission.make(() => undefined)
  const original = new Error("actual body failure")
  const result = await Effect.runPromise(
    Effect.exit(
      controller.run(
        {
          repos: path.join(tmp.path, "repos"),
          state: path.join(tmp.path, "state"),
          target: path.join(tmp.path, "repos", "checkout"),
        },
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.rename(path.join(tmp.path, "repos"), path.join(tmp.path, "retained-repos"))
            await fs.mkdir(path.join(tmp.path, "repos"))
          })
          return yield* Effect.fail(original)
        }),
      ),
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause)
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw error
    expect(error.errors).toContain(original)
    expect(errors(error).some((item) => String(item).includes("binding changed"))).toBe(true)
  }
  expect(controller.snapshot().active).toBe(0)
  expect(Exit.isFailure(await Effect.runPromise(Effect.exit(controller.drain)))).toBe(true)
})

test("reused cache refuses an external Git administration directory", async () => {
  await using tmp = await tmpdir()
  const remote = await gitRemote(tmp.path)
  const controller = RepositoryAdmission.make(() => undefined)
  await Effect.runPromise(
    RepositoryAdmission.provide(
      controller,
      Effect.gen(function* () {
        const cache = yield* RepositoryCache.Service
        const input = { reference: remote.reference, branch: "main" }
        yield* cache.ensure(input)
        const checkout = Repository.cachePath(path.join(tmp.path, "repos"), remote.reference, "main")
        const external = path.join(tmp.path, "external-admin")
        yield* Effect.promise(async () => {
          await fs.rename(path.join(checkout, ".git"), external)
          await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${external}\n`)
          await fs.writeFile(path.join(checkout, "README.md"), "preserve uncommitted data")
        })
        const before = yield* Effect.promise(() => fs.readFile(path.join(external, "config")))
        const result = yield* Effect.exit(cache.ensure({ ...input, refresh: true }))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toContain("escaped cache namespace")
        expect(yield* Effect.promise(() => fs.readFile(path.join(external, "config")))).toEqual(before)
        expect(yield* Effect.promise(() => fs.readFile(path.join(checkout, "README.md"), "utf8"))).toBe(
          "preserve uncommitted data",
        )
      }).pipe(Effect.provide(layer(tmp.path))),
    ),
  )
  expect(controller.snapshot().active).toBe(0)
}, 30_000)
