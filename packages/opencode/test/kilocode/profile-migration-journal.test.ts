import { expect, test } from "bun:test"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { captureJournal, journal } from "../../src/kilocode/migration/profile-migration-journal"

test("inactive journal requires the exact shipped catalog and retains source timestamps", () => {
  const rows = migrations.map((entry, index) => ({ id: entry.id, time_completed: index + 1 }))
  const value = captureJournal([...rows].reverse())!
  expect(value.rows).toEqual(rows)
  expect(value.activation).toBe("inert")
  expect(value.reconstruction).toBe(false)
  expect(captureJournal(rows.slice(1))).toBeUndefined()
  expect(captureJournal([...rows, rows[0]])).toBeUndefined()
  expect(
    captureJournal(rows.map((entry, index) => (index === 0 ? { ...entry, id: "unknown-migration" } : entry))),
  ).toBeUndefined()
  expect(
    captureJournal(rows.map((entry, index) => (index === 0 ? { ...entry, time_completed: -1 } : entry))),
  ).toBeUndefined()
  const changed = structuredClone(value)
  changed.rows[0].time_completed++
  expect(journal.safeParse(changed).success).toBe(false)
  expect(journal.safeParse({ ...value, catalog: "0".repeat(64) }).success).toBe(false)
})
