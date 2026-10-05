import { Database } from "bun:sqlite"
import { Rpc } from "../../../src/util/rpc"
import { workerIntake } from "../../../src/kilocode/cli/cmd/tui/worker-intake"

const release = Promise.withResolvers<void>()
let db: Database | undefined
export const rpc = {
  async hold(input: { path: string }) {
    db = new Database(input.path)
    db.run("CREATE TABLE accepted(value TEXT)")
    db.run("INSERT INTO accepted VALUES ('before shutdown')")
    Rpc.emit("held", null)
    await release.promise
    db.run("INSERT INTO accepted VALUES ('joined')")
    return "joined"
  },
  async fail() {
    throw new Error("actual RPC refusal")
  },
  async shutdown() {
    const rows = db?.query("SELECT value FROM accepted ORDER BY rowid").all()
    db?.close()
    Rpc.emit("closed", null)
    return rows
  },
}
let begun = 0
Rpc.listen(
  rpc,
  workerIntake(async () => {
    begun += 1
    Rpc.emit("quiescing", begun)
  }),
)
const listener = onmessage
onmessage = (event) => {
  if (event.data === "fixture.release") {
    release.resolve()
    return
  }
  return listener?.call(self, event)
}
Rpc.emit("ready", null)
