import { Database as Native } from "bun:sqlite"
import { Effect, Exit, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { databaseSnapshot } from "@opencode-ai/core/kilocode/profile-database"
import { Rpc } from "../../../src/util/rpc"
import { workerIntake } from "../../../src/kilocode/cli/cmd/tui/worker-intake"
import { retire, shutdown } from "../../../src/kilocode/cli/cmd/tui/worker-shutdown"

const release = Promise.withResolvers<void>()
async function setup(input: { file: string; failed: boolean }) {
  const current = makeRuntime(Database.Service, Database.layerFromPath(input.file))
  await current.runPromise((s) => s.db.run("CREATE TABLE worker_retirement(value TEXT)"))
  const heap = Effect.runSync(Scope.make())
  const instances = Effect.runSync(Scope.make())
  const server = Effect.runSync(Scope.make())
  const handler = Effect.runSync(Scope.make())
  const events: string[] = []
  if (input.failed)
    await Effect.runPromise(Scope.addFinalizer(heap, Effect.die(new Error("actual worker heap finalizer failed"))))
  await Effect.runPromise(
    Scope.addFinalizer(
      instances,
      Effect.promise(async () => {
        await current.runPromise((s) => s.db.run("INSERT INTO worker_retirement VALUES ('cleanup')"))
        events.push("instances")
      }),
    ),
  )
  await Effect.runPromise(
    Scope.addFinalizer(
      server,
      Effect.sync(() => {
        events.push("server")
      }),
    ),
  )
  await Effect.runPromise(
    Scope.addFinalizer(
      handler,
      Effect.sync(() => {
        events.push("handler")
      }),
    ),
  )
  const run = shutdown({
    drain: async () => {
      events.push("ingest")
    },
    stopHeap: () => Effect.runPromise(Scope.close(heap, Exit.void)),
    dispose: () => Effect.runPromise(Scope.close(instances, Exit.void)),
    stopServer: () => Effect.runPromise(Scope.close(server, Exit.void)),
    closeHandler: () => Effect.runPromise(Scope.close(handler, Exit.void)),
    retire: async () => {
      try {
        await retire()
      } finally {
        Rpc.emit("native", { ...databaseSnapshot(input.file), events })
      }
    },
  })
  return { current, run, file: input.file }
}
let state: Awaited<ReturnType<typeof setup>> | undefined
function get() {
  if (!state) throw new Error("Worker fixture is not initialized")
  return state
}
export const rpc = {
  async init(input: { file: string; failed: boolean }) {
    state = await setup(input)
  },
  async hold() {
    return get().current.runPromise((s) =>
      s.db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run("INSERT INTO worker_retirement VALUES ('before')")
          Rpc.emit("held", null)
          yield* Effect.promise(() => release.promise)
          yield* tx.run("INSERT INTO worker_retirement VALUES ('joined')")
          return "joined"
        }),
      ),
    )
  },
  async shutdown() {
    const current = get()
    const first = current.run()
    if (current.run() !== first) throw new Error("Worker cleanup did not join")
    try {
      await first
    } catch (err) {
      Rpc.emit("failure", String(err))
      throw err
    }
    using db = new Native(current.file, { readonly: true })
    return db.query("SELECT value FROM worker_retirement ORDER BY rowid").all()
  },
}
Rpc.listen(rpc, workerIntake())
const listener = onmessage
onmessage = (event) => {
  if (event.data === "fixture.release") {
    release.resolve()
    return undefined
  }
  return listener?.call(self, event)
}
Rpc.emit("ready", null)
