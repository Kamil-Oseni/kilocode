import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Effect, Layer, Logger } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Config } from "../../src/config/config"
import { Snapshot } from "../../src/snapshot"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

const prior = process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS

afterEach(() => {
  if (prior === undefined) delete process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS
  else process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = prior
})

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  return out.trim()
}

async function track(dir: string) {
  const calls: string[][] = []
  const rows: unknown[] = []
  const logger = Logger.make((options) => {
    rows.push(options.message)
  })
  const recorder = Layer.effect(
    AppProcess.Service,
    Effect.gen(function* () {
      const process = yield* AppProcess.Service
      return AppProcess.Service.of({
        ...process,
        run: (cmd, opts) =>
          Effect.suspend(() => {
            if (cmd._tag === "StandardCommand") calls.push([...cmd.args])
            return process.run(cmd, opts)
          }),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node)))
  const hash = await Effect.runPromise(
    Snapshot.Service.use((snapshot) => snapshot.track()).pipe(
      provideInstance(dir),
      Effect.provide(
        Snapshot.layer.pipe(
          Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Config.node, EffectFlock.node]))),
          Layer.provide(recorder),
        ),
      ),
      Effect.provide(testInstanceStoreLayer),
      Effect.provide(Logger.layer([logger])),
    ),
  )
  expect(hash).toBeTruthy()
  const command = calls.find((cmd) => cmd.includes("write-tree") && cmd.includes("--git-dir"))!
  const store = command[command.indexOf("--git-dir") + 1]
  const files = (await git(dir, "--git-dir", store, "ls-tree", "-r", "--name-only", hash!)).split("\n")
  return { calls, files, rows }
}

test("actual Snapshot.track advertises original AppProcess PID and safe caller category", async () => {
  process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = "1"
  await using tmp = await tmpdir()
  await writeFile(path.join(tmp.path, "work.txt"), "private synthetic work")
  const result = await track(tmp.path)
  const rows = result.rows
    .flat()
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && "pid" in value)
  expect(rows.length).toBeGreaterThan(0)
  expect(
    rows.some(
      (value) => value.caller === "Snapshot.track" && value.operation === "write-tree" && Number.isInteger(value.pid),
    ),
  ).toBe(true)
  expect(
    rows.every(
      (value) =>
        value.parentPID === process.pid && value.diagnosticOnly === true && value.retirementAuthority === false,
    ),
  ).toBe(true)
  expect(JSON.stringify(rows)).not.toContain(tmp.path)
  expect(JSON.stringify(rows)).not.toContain("private synthetic work")
}, 30000)
