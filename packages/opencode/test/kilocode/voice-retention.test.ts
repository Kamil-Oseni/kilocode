import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { make } from "@/kilocode/voice/openai-retention"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

it.live("legacy voice cleanup erases only the exact parent's records and is repeatable", () => Effect.gen(function* () {
  const root = yield* tmpdirScoped()
  const fs = yield* FSUtil.Service
  const dir = path.join(root, "raya_openai_voice")
  const owned = path.join(dir, "owned.json")
  const other = path.join(dir, "other.json")
  const pending = path.join(dir, ".review-crashed.tmp")
  yield* fs.writeWithDirs(owned, JSON.stringify({ binding: { parentSessionID: "ses_owned" }, images: { secret: "private" } }))
  yield* fs.writeWithDirs(other, JSON.stringify({ binding: { parentSessionID: "ses_other" } }))
  yield* fs.writeWithDirs(pending, JSON.stringify({ binding: { parentSessionID: "ses_owned" }, images: { secret: "private" } }))
  const retention = make(fs, root)
  yield* retention.remove("ses_owned")
  expect(yield* fs.exists(owned)).toBe(false)
  expect(yield* fs.exists(pending)).toBe(false)
  expect(yield* fs.exists(other)).toBe(true)
  yield* retention.remove("ses_owned")
  yield* retention.remove("ses_other")
  expect(yield* fs.exists(other)).toBe(false)
  yield* make(fs, path.join(root, "missing")).remove("ses_owned")
}), 30_000)

it.live("legacy cleanup does not report success for unreadable or unidentified records", () => Effect.gen(function* () {
  const root = yield* tmpdirScoped()
  const fs = yield* FSUtil.Service
  const file = path.join(root, "raya_openai_voice", "corrupt.json")
  const retention = make(fs, root)
  yield* fs.writeWithDirs(file, "invalid JSON")
  expect(Exit.isFailure(yield* retention.remove("ses_owned").pipe(Effect.exit))).toBe(true)
  yield* fs.writeJson(file, { binding: {} })
  expect(Exit.isFailure(yield* retention.remove("ses_owned").pipe(Effect.exit))).toBe(true)
  yield* fs.remove(file)
  yield* fs.makeDirectory(file)
  expect(Exit.isFailure(yield* retention.remove("ses_owned").pipe(Effect.exit))).toBe(true)
}), 30_000)
