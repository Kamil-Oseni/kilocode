import { Effect, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { publish } from "../../../../src/kilocode/session/review-publish"

const target = process.argv[2]
const owner = process.argv[3]
if (!target || !owner) throw new Error("Expected receipt path and owner")
const claimed = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* publish(fs, target, { owner })
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)
process.exitCode = claimed ? 0 : 10
