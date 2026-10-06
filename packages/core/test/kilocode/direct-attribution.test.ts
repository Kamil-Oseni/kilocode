import { afterEach, expect, test } from "bun:test"
import { Effect, Logger, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "../../src/effect/layer-node"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { footer, records } from "../../src/kilocode/direct-attribution"

const prior = process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS

afterEach(() => {
  if (prior === undefined) delete process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS
  else process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = prior
})

test.skipIf(process.platform !== "win32")(
  "real shell child and owned cancellation retain original cmd close identities",
  async () => {
    process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = "1"
    const logs: unknown[] = []
    const logger = Logger.make((options) => {
      logs.push(options.message)
    })
    const pid = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const shell = yield* spawner.spawn(ChildProcess.make("echo", ["synthetic-fixture"], { shell: true }))
        const [code] = yield* Effect.all(
          [shell.exitCode, Stream.runDrain(shell.stdout), Stream.runDrain(shell.stderr)],
          {
            concurrency: "unbounded",
          },
        )
        expect(Number(code)).toBe(0)
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},10000)"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        yield* child.kill()
        yield* child.exitCode
        return Number(child.pid)
      }).pipe(
        Effect.scoped,
        Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
        Effect.provide(Logger.layer([logger])),
      ),
    )
    const rows = records()
    expect(rows.some((row) => row.pid === pid && row.operation === "spawn" && row.code !== null)).toBe(true)
    expect(rows.some((row) => row.operation === "shell" && row.image === "cmd" && row.code === 0)).toBe(true)
    expect(
      rows.some(
        (row) => row.operation === "taskkill" && row.image === "cmd" && row.code === 0 && row.stderrBytes !== null,
      ),
    ).toBe(true)
    expect(rows.every((row) => row.parentPID === process.pid && row.retirementAuthority === false)).toBe(true)
    expect(footer().recordsComplete).toBe(true)
    expect(logs.flat().some((value) => value === "source direct process diagnostic footer")).toBe(true)
    expect(JSON.stringify(rows)).not.toContain("synthetic-fixture")
    expect(JSON.stringify(rows)).not.toContain("setInterval")
  },
  15000,
)
