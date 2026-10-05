import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../../src/global"
import { Log } from "../../../src/util/log"

const dir = process.argv[2]
const mode = process.argv[3]
Global.Path.log = path.join(dir, "selected")
if (mode === "unused") {
  const first = Log.drain()
  assert.equal(Log.drain(), first)
  await first
  assert.equal(await fs.exists(Global.Path.log), false)
  assert.equal(Log.file(), "")
}
if (mode === "success") {
  await fs.mkdir(Global.Path.log)
  await Log.init({ print: false, dev: true })
  Log.Default.info("final-production-marker")
  const file = Log.file()
  const first = Log.drain()
  assert.equal(Log.drain(), first)
  await first
  const before = await fs.readFile(file, "utf8")
  assert.match(before, /final-production-marker/)
  Log.Default.info("late-stderr-marker")
  assert.equal(await fs.readFile(file, "utf8"), before)
  await assert.rejects(Log.init({ print: false }), /admission is closed/)
}
if (mode === "failure") {
  await fs.mkdir(path.join(Global.Path.log, "dev.log"), { recursive: true })
  const err = await Log.init({ print: false, dev: true }).catch((err: unknown) => err)
  assert.ok(err instanceof Error)
  await Log.init({ print: true })
  const first = Log.drain()
  const failed = await first.catch((err: unknown) => err)
  assert.ok(failed instanceof AggregateError)
  assert.ok(failed.errors.includes(err))
  assert.equal(Log.drain(), first)
  assert.equal(await Log.drain().catch((err: unknown) => err), failed)
}
console.log(JSON.stringify({ mode, passed: true }))
