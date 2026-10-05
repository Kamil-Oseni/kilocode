import { Database } from "bun:sqlite"
import { Effect, Exit, Scope } from "effect"
import { Rpc } from "../../../src/util/rpc"
import * as WorkerIdentity from "../../../src/kilocode/cli/cmd/tui/worker-identity"
import { workerIntake } from "../../../src/kilocode/cli/cmd/tui/worker-intake"
import { observation } from "../../../src/kilocode/cli/profile-retirement"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"

const owner = WorkerIdentity.identity(process.env)
const accept = WorkerIdentity.bind(owner)
const intake = workerIntake()
const scope = Effect.runSync(Scope.make())
export const rpc = {
  async init(input: { file: string; release: string }) {
    const db = profileSqlite(input.file, (file) => new Database(file))
    db.run("CREATE TABLE finalized(value TEXT)")
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          Rpc.emit("held", null)
          while (!(await Bun.file(input.release).exists())) await Bun.sleep(5)
          db.run("INSERT INTO finalized VALUES ('durable')")
          db.close()
        }),
      ),
    )
  },
  async shutdown(input: ReturnType<typeof WorkerIdentity.request>) {
    const request = WorkerIdentity.accept(input, owner)
    Rpc.emit("requested", 1)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const reply = WorkerIdentity.acknowledge(request, observation())
    onmessage = null
    return reply
  },
}
Rpc.listen(rpc, (method, work, input) => {
  if (method === "shutdown") accept(input)
  return intake(method, work)
})
Rpc.emit("ready", null)
