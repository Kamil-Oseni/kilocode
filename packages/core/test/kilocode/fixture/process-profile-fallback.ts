import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { closeProcessProfile, processProfileSnapshot } from "../../../src/kilocode/process-profile"

const root = process.env.KILO_TEST_HOME!
const mode = process.argv[2]
const state = path.join(root, ".local", "state")
await mkdir(path.dirname(state), { recursive: true })
if (mode === "parent") await writeFile(state, "not a directory")
if (mode === "preferred") {
  await mkdir(state)
  await writeFile(path.join(state, "kilo"), "not a directory")
}
if (mode === "explicit") {
  await writeFile(process.env.XDG_STATE_HOME!, "not a directory")
  await assert.rejects(import("../../../src/global"))
  await closeProcessProfile()
  console.log(JSON.stringify({ passed: true, mode, refused: true }))
} else {
  const global = await import("../../../src/global")
  assert.equal(global.Path.state, path.join(root, "data", "kilo", "state"))
  assert.ok(processProfileSnapshot().roots.includes(global.Path.state))
  await closeProcessProfile()
  console.log(JSON.stringify({ passed: true, mode, active: processProfileSnapshot().roots.length }))
}
