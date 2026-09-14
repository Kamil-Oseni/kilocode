import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import * as Output from "@/kilocode/tool/reviewed-output"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))
const bytes = (text: string) => Buffer.from(text)

describe("reviewed binary output", () => {
  it.instance("creates nested output beneath the reviewed ancestor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const io = yield* FSUtil.Service
      const target = path.join(test.directory, "nested", "report.bin")
      const review = yield* Output.review(io, target)

      yield* Output.commit(target, bytes("created"), review)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("created")
    }),
  )

  it.instance("preserves a destination another writer creates after review", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const io = yield* FSUtil.Service
      const target = path.join(test.directory, "claimed.bin")
      const review = yield* Output.review(io, target)
      yield* Effect.promise(() => fs.writeFile(target, "user content"))

      const result = yield* Output.commit(target, bytes("private content"), review).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("user content")
    }),
  )

  it.instance("writes nowhere after the reviewed parent is replaced", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const io = yield* FSUtil.Service
      const parent = path.join(test.directory, "reviewed")
      const moved = path.join(test.directory, "moved")
      const target = path.join(parent, "private.bin")
      yield* Effect.promise(() => fs.mkdir(parent))
      const review = yield* Output.review(io, target)
      yield* Effect.promise(async () => {
        await fs.rename(parent, moved)
        await fs.mkdir(parent)
      })

      const result = yield* Output.commit(target, bytes("private content"), review).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("parent changed after approval")
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(moved, "private.bin")).exists())).toBe(false)
    }),
  )

  it.instance("preserves replaced and newer existing output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const io = yield* FSUtil.Service
      const target = path.join(test.directory, "report.bin")
      const moved = path.join(test.directory, "approved.bin")
      yield* Effect.promise(() => fs.writeFile(target, "approved"))
      const review = yield* Output.review(io, target)
      yield* Effect.promise(async () => {
        await fs.rename(target, moved)
        await fs.writeFile(target, "replacement")
      })

      expect(Exit.isFailure(yield* Output.commit(target, bytes("agent"), review).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("replacement")
      expect(yield* Effect.promise(() => fs.readFile(moved, "utf8"))).toBe("approved")

      const current = yield* Output.review(io, target)
      yield* Effect.promise(() => fs.writeFile(target, "newer user content"))
      expect(Exit.isFailure(yield* Output.commit(target, bytes("agent"), current).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer user content")
    }),
  )

  it.instance("refuses a hard link added after review without changing either name", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const io = yield* FSUtil.Service
      const target = path.join(test.directory, "report.bin")
      const alias = path.join(test.directory, "alias.bin")
      yield* Effect.promise(() => fs.writeFile(target, "approved"))
      const review = yield* Output.review(io, target)
      yield* Effect.promise(() => fs.link(target, alias))

      const result = yield* Output.commit(target, bytes("agent"), review).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Hard-linked files")
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("approved")
      expect(yield* Effect.promise(() => fs.readFile(alias, "utf8"))).toBe("approved")
    }),
  )
})
