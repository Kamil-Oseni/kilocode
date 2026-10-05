import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { Effect, Exit, ManagedRuntime, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { observation } from "../../../src/kilocode/cli/profile-retirement"
import { prepare } from "../../../src/kilocode/migration/source-host"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
const mode = process.argv[3]
assert.ok(root)
const step = (value: string) => writeFile(path.join(root, "step.json"), JSON.stringify({ value }))
await step("database")
const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(root, "source.db")))
const db = await runtime.runPromise(Database.Service)
await step("write")
await runtime.runPromise(db.db.run("CREATE TABLE durable(value TEXT)"))
await runtime.runPromise(db.db.run("INSERT INTO durable VALUES ('initial')"))
const scope = await Effect.runPromise(Scope.make())
await Effect.runPromise(
  Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      await writeFile(path.join(root, "held.json"), '{"held":true}')
      while (!(await Bun.file(path.join(root, "continue")).exists())) await Bun.sleep(25)
      await runtime.runPromise(db.db.run("INSERT INTO durable VALUES ('finalizer-persisted')"))
    }),
  ),
)
const digest = createHash("sha256")
  .update(Buffer.from(await Bun.file(process.execPath).arrayBuffer()))
  .digest("hex")
await step("prepare")
const input = {
  scope: observation().roots,
  expected: { executable: process.execPath, digest: mode === "wrong-pin" ? "0".repeat(64) : digest },
  command: [
    mode === "bad-command"
      ? (process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe"))
      : process.execPath,
    path.join(import.meta.dir, "source-host-successor.ts"),
  ],
}
if (mode === "wrong-pin" || mode === "bad-command") {
  const failure = await prepare(input).then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(failure instanceof Error)
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ message: failure.message }))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await runtime.dispose()
  process.exitCode = 1
  await finish([])
}
const closing = prepare(input)
const ticket = await closing
if (mode === "conflict") {
  assert.equal(prepare(input), closing)
  const failure = await prepare({ ...input, expected: { ...input.expected, digest: "0".repeat(64) } }).then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(failure instanceof Error)
  await writeFile(path.join(root, "conflict.json"), JSON.stringify({ refused: true }))
}
await writeFile(path.join(root, "prepared.json"), JSON.stringify(ticket))
await Effect.runPromise(Scope.close(scope, Exit.void))
await runtime.dispose()
if (mode === "wrong-ack" || mode === "missing-ack")
  process.on("exit", () => {
    const file = path.join(ticket.control, "ack.json")
    if (mode === "missing-ack") {
      unlinkSync(file)
      return
    }
    const value = JSON.parse(readFileSync(file, "utf8"))
    value.value.id = crypto.randomUUID()
    writeFileSync(file, JSON.stringify(value))
  })
process.exitCode = mode === "failed-exit" ? 1 : 0
await finish([])
