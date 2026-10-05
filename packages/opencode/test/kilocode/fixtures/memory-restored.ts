import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type z from "zod"
import { memories, memory } from "../../../src/kilocode/migration/profile-memory"

export async function verify(data: string, expected: readonly z.output<typeof memory>[]) {
  const actual = await memories(path.join(data, "memory"))
  assert.equal(actual.length, expected.length)
  for (const item of expected) {
    const matches = actual.filter((value) => JSON.stringify(value.sources) === JSON.stringify(item.sources))
    assert.equal(matches.length, 1)
    const value = matches[0]
    assert.deepEqual(value.sessions, item.sessions)
    assert.equal(value.decisions, item.decisions)
    for (const record of item.lineage?.records ?? [])
      assert(value.lineage?.records.some((current) => JSON.stringify(current) === JSON.stringify(record)))
    const state = JSON.parse(value.state)
    assert.equal(state.enabled, false)
    assert.equal(state.autoConsolidate, false)
    assert.equal(state.capture.turnClose, false)
    assert.equal(state.capture.explicit, false)
  }
  const hold = JSON.parse(await readFile(path.join(data, "storage", "raya", "restore-hold.json"), "utf8"))
  assert.equal(hold.state, "held")
}
