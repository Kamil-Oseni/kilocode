import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import * as Files from "../../src/kilocode/tool/task-files-schema"
import * as Portable from "../../src/kilocode/migration/profile-task-files"

const directory = path.resolve("task-codec-workspace")
const binding = (child: string) =>
  Schema.decodeUnknownSync(Files.Binding)({
    version: 1,
    child,
    parent: "ses_parent",
    directory,
    declared: ["notes.txt"],
    canonical: [path.join(directory, "notes.txt")],
    branch: "review",
  })
const record = (value: Files.Binding) => ({
  path: `raya/task-files/${createHash("sha256").update(value.child).digest("hex")}.json`,
  value: JSON.stringify(value),
})
const source = () => {
  const bound = binding("ses_bound"),
    orphan = binding("ses_unpublished")
  return {
    json: [record(bound), record(orphan)],
    sql: [
      {
        table: "session",
        columns: ["id", "parent_id", "directory", "metadata"],
        rows: [
          ["ses_parent", null, directory, null],
          [bound.child, bound.parent, directory, JSON.stringify({ [Files.key]: bound })],
        ],
      },
    ],
  }
}

test("portable Task declarations distinguish published children from inert unpublished allocations", () => {
  const content = source()
  const entries = Portable.collect(content)
  expect(entries.map((item) => item.relation).sort()).toEqual(["bound", "unpublished"])
  for (const item of content.json) {
    expect(Portable.classify(item.path, item.value, content)).toBe(
      JSON.parse(item.value).child === "ses_bound" ? "task-files" : "task-files-orphan",
    )
  }
  expect(entries.find((item) => item.relation === "bound")?.binding).toEqual(binding("ses_bound"))
  expect(
    Portable.collect({ json: [], sql: [{ table: "session", columns: ["directory"], rows: [[directory]] }] }),
  ).toEqual([])
  expect(
    Portable.collect({
      json: [],
      sql: [{ table: "session", columns: ["id", "metadata"], rows: [["ses_legacy", "{}"]] }],
    }),
  ).toEqual([])
})

test("portable Task declarations refuse missing or changed immutable scope and marker correspondence", () => {
  const absent = source()
  absent.json = absent.json.filter((item) => JSON.parse(item.value).child !== "ses_bound")
  expect(() => Portable.collect(absent)).toThrow("lacks its immutable")
  const unmarked = source()
  unmarked.sql[0].rows[1][3] = "{}"
  expect(() => Portable.collect(unmarked)).toThrow()
  const changed = source()
  changed.sql[0].rows[1][3] = JSON.stringify({ [Files.key]: { ...binding("ses_bound"), declared: [] } })
  expect(() => Portable.collect(changed)).toThrow()
  const parent = source()
  parent.sql[0].rows = parent.sql[0].rows.slice(1)
  expect(() => Portable.collect(parent)).toThrow("disagrees")
  const incomplete = source()
  incomplete.sql[0].columns = ["id", "metadata"]
  expect(() => Portable.collect(incomplete)).toThrow("columns are incomplete")
})

test("portable Task declarations reject forged filenames, changed canonical files and oversized raw records", () => {
  const wrong = source()
  wrong.json[0].path = `raya/task-files/${"0".repeat(64)}.json`
  expect(() => Portable.collect(wrong)).toThrow("hash or identity")
  const invalid = source()
  invalid.json[0].path = "raya/task-files/other.json"
  expect(() => Portable.collect(invalid)).toThrow("path or byte bound")
  const changed = source()
  changed.json[0].value = JSON.stringify({
    ...JSON.parse(changed.json[0].value),
    canonical: [path.join(directory, "foreign.txt")],
  })
  expect(() => Portable.collect(changed)).toThrow("unchanged declaration")
  const large = source()
  large.json[0].value = " ".repeat(196609)
  expect(() => Portable.collect(large)).toThrow("byte bound")
  expect(Portable.filename("raya/task-files/../other.json")).toBe(false)
})
