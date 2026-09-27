import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Snapshot.defaultLayer, FSUtil.defaultLayer))

it.instance(
  "concurrent snapshot track and patch finish in a plain folder",
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const fs = yield* FSUtil.Service
    const snapshot = yield* Snapshot.Service
    const file = path.join(tmp.directory, "note.txt")

    yield* fs.writeWithDirs(file, "before\n")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    if (!before) throw new Error("initial snapshot missing")

    yield* fs.writeWithDirs(file, "after\n")
    const [after, patch] = yield* Effect.all([snapshot.track(), snapshot.patch(before)], {
      concurrency: "unbounded",
    })

    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    expect(patch.files).toContain(file.replaceAll("\\", "/"))
  }),
  { git: false },
  30_000,
)
