import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaTaskDelegation } from "../../../src/kilocode/task/delegation"

const file = process.argv[2]
const recipient = process.argv[3]
if (!file || !recipient) throw new Error("Expected database path and recipient")

await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const row = yield* RayaTaskDelegation.make(database).take(recipient)
    if (!row?.childRunID) return yield* Effect.die(new Error("Expected accepted delegation"))
    return process.exit(21)
  }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
)
