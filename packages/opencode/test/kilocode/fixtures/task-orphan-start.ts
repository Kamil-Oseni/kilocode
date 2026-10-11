import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { provideInstance } from "../../fixture/fixture"
import { profile } from "./task-orphan-profile"

const dir = process.argv[2]
const kind = process.argv[3]
const boundary = process.argv[4] ?? "linked"
if (!dir || (kind !== "manual" && kind !== "event") || (boundary !== "linked" && boundary !== "unlinked"))
  throw new Error("Expected physical profile, trigger, and boundary")

await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const guarded = {
      ...storage,
      replace: (key: string[], value: unknown) => {
        const selected =
          boundary === "linked"
            ? key[1] === "agent-runs"
            : key[1] === "agent-claims" &&
              typeof value === "object" &&
              value !== null &&
              "phase" in value &&
              value.phase === "session-created"
        if (key[0] !== "raya" || !selected) return storage.replace(key, value)
        return Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(dir, "boundary.json"), JSON.stringify({ key, value })))
          // Crash the actual original runner before its real claim-link or history publication.
          process.exit(23)
        })
      },
    }
    const runner = RayaTaskRunner.make({
      storage: guarded,
      database,
      sessions,
      continuation: () => Effect.die("Original startup must not dispatch before history"),
    })
    const worker = yield* runner.tasks.create({
      name: "Interrupted original worker",
      objective: "ORIGINAL_START_MUST_NOT_REPLAY",
      access: "brief",
      enabled: true,
      schedule: kind === "manual" ? { kind } : { kind, source: "orphan-event" },
    })
    if (kind === "manual") yield* runner.fire(worker.id)
    if (kind === "event") yield* runner.announce("orphan-event")
    throw new Error("Actual original runner never reached the retained boundary")
  }).pipe(provideInstance(dir), Effect.provide(profile(dir))),
)
