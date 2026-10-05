import assert from "node:assert/strict"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Effect, Exit, ManagedRuntime, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { context } from "@opencode-ai/core/kilocode/source-launch"
import { prepare } from "../../../src/kilocode/migration/source-host"
import { finish } from "../../../src/kilocode/cli/finish"
const root = process.argv[2]
const mode = process.argv[3]
const job = await context()
assert.ok(job)
const file =
  mode === "policy-escape"
    ? path.join(path.dirname(root), `${path.basename(root)}-external.db`)
    : path.join(root, "source.db")
const runtime = ManagedRuntime.make(Database.layerFromPath(file))
const db = await runtime.runPromise(Database.Service)
await runtime.runPromise(db.db.run("CREATE TABLE durable(value TEXT)"))
const child = spawn(process.execPath, [path.join(import.meta.dir, "source-family-child.ts"), root, mode], {
  detached: true,
  windowsHide: true,
  stdio: "ignore",
})
child.unref()
while (!(await Bun.file(path.join(root, "child-ready.json")).exists())) await Bun.sleep(25)
const scope = await Effect.runPromise(Scope.make())
await Effect.runPromise(
  Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      await Bun.write(path.join(root, "held-source.json"), JSON.stringify({ held: true }))
      while (!(await Bun.file(path.join(root, "release-source")).exists())) await Bun.sleep(25)
      await runtime.runPromise(db.db.run("INSERT INTO durable VALUES ('source-final')"))
      if (mode === "failed-finalizer") throw new Error("Actual source finalizer failed after native persistence")
    }),
  ),
)
const digest = createHash("sha256")
  .update(await Bun.file(process.execPath).bytes())
  .digest("hex")
const ticket = await prepare({
  scope: job.header.roots,
  expected: { executable: process.execPath, digest },
  command: [
    process.execPath,
    path.join(import.meta.dir, mode.startsWith("policy") ? "source-policy-successor.ts" : "source-host-successor.ts"),
  ],
})
await Bun.write(path.join(root, "prepared.json"), JSON.stringify(ticket))
await Effect.runPromise(Scope.close(scope, Exit.void)).catch(async (err: unknown) => {
  await Bun.write(path.join(root, "cleanup-failure.json"), JSON.stringify({ error: String(err) }))
  process.exitCode = 1
})
await runtime.dispose()
await finish([])
