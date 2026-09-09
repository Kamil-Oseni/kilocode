import path from "node:path"
import { Effect, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { claim } from "../../../src/kilocode/task/claim"
import { recover } from "../../../src/kilocode/task/recovery"
import { Storage } from "../../../src/storage/storage"
import { publish } from "../../../src/kilocode/session/review-publish"

const directory = process.argv[2]
const owner = process.argv[3]
if (!directory || !owner) throw new Error("Expected directory and owner")
process.exitCode = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = (key: string[]) => path.join(directory, ...key) + ".json"
    const storage = {
      create: (key: string[], value: unknown) => publish(fs, file(key), value),
      read: (key: string[]) =>
        fs.readFileString(file(key)).pipe(
          Effect.mapError((error) =>
            error.reason._tag === "NotFound" ? new Storage.NotFoundError({ message: "missing" }) : error,
          ),
          Effect.map((value): unknown => JSON.parse(value)),
        ),
      replace: (key: string[], value: unknown) => publish(fs, file(key), value, true).pipe(Effect.asVoid),
      remove: (key: string[]) => fs.remove(file(key)),
    }
    if (process.argv[4] === "recover") return (yield* recover(storage, "routine", () => Effect.succeed(true))) ? 0 : 10
    if (process.argv[4] === "recover-crash") {
      let checks = 0
      return (yield* recover(storage, "routine", () =>
        Effect.sync(() => {
          checks++
          if (checks === 2) process.exit(21)
          return true
        }),
      ))
        ? 0
        : 10
    }
    return yield* claim(storage, "routine", Effect.void, () =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(directory, "started.txt"), owner)
        return yield* Effect.fail("simulated-stop" as const)
      }),
    ).pipe(
      Effect.catch((error) => {
        if (error === "simulated-stop") return Effect.succeed(20)
        if (typeof error === "object" && "_tag" in error && error._tag === "RayaTask.GuardError")
          return Effect.succeed(10)
        return Effect.die(error)
      }),
    )
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)
