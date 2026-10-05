import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { Hash } from "../../src/util/hash"
import { EffectFlock } from "../../src/util/effect-flock"
import { RepositoryAdmission } from "../../src/kilocode/repository-admission"
import { tmpdir } from "../fixture/tmpdir"

async function hold(root: string, item: string) {
  const ready = path.join(root, "ready")
  const stop = path.join(root, "stop")
  const child = Bun.spawn(
    [
      "pwsh",
      "-NoProfile",
      "-File",
      path.join(import.meta.dir, "fixture", "repository-file-hold.ps1"),
      "-Item",
      item,
      "-Ready",
      ready,
      "-Stop",
      stop,
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const deadline = Date.now() + 5_000
  while (!(await Bun.file(ready).exists())) {
    if (Date.now() > deadline) throw new Error("Actual file holder did not become ready")
    await Bun.sleep(10)
  }
  return async () => {
    await fs.writeFile(stop, "stop")
    const code = await child.exited
    const [out, err] = await output
    expect(code).toBe(0)
    expect(out).toBe("")
    expect(err).toBe("")
  }
}

function graph(root: string, filesystem?: Layer.Layer<FSUtil.Service>) {
  return AppNodeBuilder.build(EffectFlock.node, [
    [
      Global.node,
      Global.layerWith({
        state: path.join(root, "state"),
        repos: path.join(root, "repos"),
        data: path.join(root, "data"),
      }),
    ],
    ...(filesystem ? [[FSUtil.node, filesystem] as const] : []),
  ])
}

test.skipIf(process.platform !== "win32")(
  "strict owned release retains a real file-sharing violation",
  async () => {
    await using tmp = await tmpdir()
    let release: (() => Promise<void>) | undefined
    let body = false
    const controller = RepositoryAdmission.make(() => undefined)
    try {
      const result = await Effect.runPromise(
        Effect.exit(
          controller.run(
            {
              repos: path.join(tmp.path, "repos"),
              state: path.join(tmp.path, "state"),
              target: path.join(tmp.path, "repos", "checkout"),
            },
            Effect.gen(function* () {
              const flock = yield* EffectFlock.Service
              yield* flock.withLock(
                Effect.promise(async () => {
                  const file = path.join(tmp.path, "state", "locks", Hash.fast("release") + ".lock", "held")
                  await fs.writeFile(file, "synthetic")
                  release = await hold(tmp.path, file)
                  body = true
                }),
                "release",
                undefined,
              )
            }).pipe(Effect.provide(graph(tmp.path))),
          ),
        ),
      )
      expect(body).toBe(true)
      expect(Exit.isFailure(result)).toBe(true)
      expect(controller.snapshot().failures).toBeGreaterThan(0)
      expect(Exit.isFailure(await Effect.runPromise(Effect.exit(controller.drain)))).toBe(true)
    } finally {
      if (release) await release()
    }
  },
  30_000,
)

test.skipIf(process.platform !== "win32")(
  "strict stale-lock cleanup refuses a real deletion failure before body",
  async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "state", "locks", Hash.fast("stale") + ".lock")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, "held")
    await fs.writeFile(file, "synthetic")
    await fs.writeFile(path.join(dir, "heartbeat"), "")
    const old = new Date(Date.now() - 120_000)
    await fs.utimes(path.join(dir, "heartbeat"), old, old)
    const release = await hold(tmp.path, file)
    let body = false
    try {
      const result = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function* () {
            yield* (yield* EffectFlock.Service).withLock(
              Effect.sync(() => {
                body = true
              }),
              "stale",
              undefined,
              { strict: true },
            )
          }).pipe(Effect.provide(graph(tmp.path))),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(body).toBe(false)
      await rejects(Bun.file(file).text())
    } finally {
      await release()
    }
    expect(await Bun.file(file).text()).toBe("synthetic")
  },
  30_000,
)

test.skipIf(process.platform !== "win32")(
  "real publication and cleanup failures preserve both original filesystem causes",
  async () => {
    await using tmp = await tmpdir()
    let release: (() => Promise<void>) | undefined
    const dir = path.join(tmp.path, "state", "locks", Hash.fast("publication") + ".lock")
    // Delegate to the actual filesystem; introduce only an actual conflicting directory and held native file.
    const filesystem = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const real = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...real,
          writeFileString: (file, text, opts) => {
            if (file !== path.join(dir, "heartbeat")) return real.writeFileString(file, text, opts)
            return Effect.promise(async () => {
              await fs.mkdir(file)
              const held = path.join(dir, "held")
              await fs.writeFile(held, "synthetic")
              release = await hold(tmp.path, held)
            }).pipe(Effect.andThen(real.writeFileString(file, text, opts)))
          },
        })
      }),
    ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
    try {
      const result = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function* () {
            yield* (yield* EffectFlock.Service).withLock(Effect.void, "publication", undefined, { strict: true })
          }).pipe(Effect.provide(graph(tmp.path, filesystem))),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(AggregateError)
        if (!(error instanceof AggregateError)) throw error
        expect(error.errors).toHaveLength(2)
        expect(error.errors[0]).not.toBe(error.errors[1])
      }
    } finally {
      if (release) await release()
    }
  },
  30_000,
)
