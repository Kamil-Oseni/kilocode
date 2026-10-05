import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Codec as Task } from "../../../src/kilocode/task/schema"
import { Codec as Goal } from "../../../src/kilocode/goal/schema"
import { Codec as Checkpoint } from "../../../src/kilocode/checkpoint/schema"
import type { StorageComponents } from "../../../src/kilocode/migration/profile-storage-correspondence"

export async function verifyStorage(json: StorageComponents["json"], restored: string) {
  let checks = 0
  const check = (value: unknown, expected: unknown) => {
    assert.deepEqual(value, expected)
    checks++
  }
  const read = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(restored, "storage", ...file.split("/")), "utf8"))
  const roster = json.find((entry) => entry.path === "raya/agent.json")
  if (!roster) return checks
  const original = Schema.decodeUnknownSync(Schema.Array(Task.Agent))(JSON.parse(roster.value))
  const agents = Schema.decodeUnknownSync(Schema.Array(Task.Agent))(await read(roster.path))
  check(
    agents.map((agent) => agent.id),
    original.map((agent) => agent.id),
  )
  for (const agent of agents) {
    check(agent.enabled, false)
    check(agent.execution, undefined)
    check(agent.nextRun, undefined)
    check(agent.name, original.find((item) => item.id === agent.id)!.name)
  }
  for (const entry of json) {
    if (entry.path === "raya/agent-initialized.json") check(await read(entry.path), { version: 1 })
    if (entry.path.startsWith("raya/agent-runs/")) {
      const prior = Schema.decodeUnknownSync(Task.History)(JSON.parse(entry.value))
      const current = Schema.decodeUnknownSync(Task.History)(await read(entry.path))
      check(
        current.runs,
        prior.runs.filter((run) => run.status === "complete" || run.status === "error"),
      )
      check(current.events, [])
      check(current.cursor, 0)
    }
    if (entry.path.startsWith("raya/goal/")) {
      const prior = Schema.decodeUnknownSync(Goal.State)(JSON.parse(entry.value))
      const current = Schema.decodeUnknownSync(Goal.State)(await read(entry.path))
      check(current.objective, prior.objective)
      check(current.status, prior.status === "active" ? "paused" : prior.status)
      check(current.activeAt, undefined)
      check(current.replyRecovery, undefined)
    }
    if (entry.path.startsWith("raya/checkpoint/"))
      check(
        Schema.decodeUnknownSync(Checkpoint.List)(await read(entry.path)),
        Schema.decodeUnknownSync(Checkpoint.List)(JSON.parse(entry.value)),
      )
  }
  return checks
}
