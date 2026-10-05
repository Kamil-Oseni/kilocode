import { Database } from "bun:sqlite"
import { Effect, Exit, Scope } from "effect"
import { Rpc } from "../../../src/util/rpc"
import * as WorkerIdentity from "../../../src/kilocode/cli/cmd/tui/worker-identity"
import { observation } from "../../../src/kilocode/cli/profile-retirement"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"
import { workerIntake } from "../../../src/kilocode/cli/cmd/tui/worker-intake"

const release = Promise.withResolvers<void>()
let db: Database | undefined
let scope: Scope.Scope | undefined
let mode = "held"
let requests = 0
const owner = WorkerIdentity.identity(process.env)
export const rpc = {
  async init(input: { file: string; mode: string }) {
    mode = input.mode
    db = profileSqlite(input.file, (file) => new Database(file))
    db.run("CREATE TABLE parent_stop(value TEXT)")
    db.run("INSERT INTO parent_stop VALUES ('before')")
    const current = db
    scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          if (mode === "held" || mode === "timeout") {
            Rpc.emit("held", null)
            await release.promise
          }
          current.run("INSERT INTO parent_stop VALUES ('finalized')")
          current.close()
        }),
      ),
    )
    if (mode === "failed")
      await Effect.runPromise(Scope.addFinalizer(scope, Effect.die(new Error("actual parent-stop finalizer failed"))))
  },
  async shutdown(input: ReturnType<typeof WorkerIdentity.request>) {
    const request = WorkerIdentity.accept(input, owner)
    requests += 1
    Rpc.emit("requested", requests)
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
    const reply = WorkerIdentity.acknowledge(request, observation())
    if (mode === "noexit") return reply
    onmessage = null
    if (mode === "badexit") setTimeout(() => process.exit(1), 0)
    if (mode === "noack") await new Promise<void>(() => undefined)
    const altered: Record<string, unknown> = { ...reply }
    if (mode === "generation") altered.generation = crypto.randomUUID()
    if (mode === "request") altered.requestID = crypto.randomUUID()
    if (mode === "run") altered.runID = "another-run"
    if (mode === "version") altered.version = 2
    if (mode === "malformed") return { status: "confirmed" }
    if (mode === "missing") delete altered.receipt
    if (mode === "scope") altered.receipt = { ...reply.receipt, inventory: "a".repeat(64) }
    if (mode === "roots")
      altered.receipt = { ...reply.receipt, roots: [{ kind: "sqlite", path: db?.filename + ".changed" }] }
    if (mode === "portable") altered.receipt = { ...reply.receipt, portable: true }
    if (mode === "global") altered.receipt = { ...reply.receipt, nativeOwners: 0, operations: 0, scope: "a".repeat(64) }
    if (["generation", "request", "run", "version", "missing", "scope", "roots", "portable", "global"].includes(mode))
      return altered
    return reply
  },
}
const intake = workerIntake()
const accept = WorkerIdentity.bind(owner)
Rpc.listen(rpc, (method, work, input) => {
  if (method === "shutdown") accept(input)
  return intake(method, work)
})
const listener = onmessage
onmessage = (event) => {
  if (event.data === "fixture.release") {
    release.resolve()
    return undefined
  }
  return listener?.call(self, event)
}
Rpc.emit("ready", null)
