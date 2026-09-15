import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Truncate } from "../../src/tool/truncate"
import { tmpdir } from "../fixture/fixture"

test("truncation operations resolve the active profile after service construction", async () => {
  await using tmp = await tmpdir()
  const dirs: string[] = []
  const writes: string[] = []
  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        ensureDir: (dir) => {
          dirs.push(dir)
          return fs.ensureDir(tmp.path)
        },
        writeFileString: (file, text, options) => {
          writes.push(file)
          return fs.writeFileString(path.join(tmp.path, path.basename(file)), text, options)
        },
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  const layer = AppNodeBuilder.build(Truncate.node, [[FSUtil.node, fsLayer]])
  const original = Global.Path.data
  const active = path.join(original, "late-bound-truncation-test")

  const file = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      Global.Path.data = active
      return yield* svc.write("full output")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          Global.Path.data = original
        }),
      ),
    ),
  )

  const dir = path.join(active, "tool-output")
  expect(Truncate.dir()).toBe(path.join(original, "tool-output"))
  expect(dirs).toEqual([dir])
  expect(writes).toEqual([file])
  expect(path.dirname(file)).toBe(dir)
  expect(await Bun.file(path.join(tmp.path, path.basename(file))).text()).toBe("full output")
})
