import { expect, test } from "bun:test"
import { project, reviewed } from "../../webview-ui/src/components/settings/brain-proposal-state"

test("project comparison follows Windows separators and case without changing Unix identity", () => {
  expect(project("C:\\Work\\Raya\\")).toBe(project("c:/work/raya"))
  expect(project("/work/Raya")).not.toBe(project("/work/raya"))
  expect(project("C:/work/other")).not.toBe(project("C:/work/raya"))
})
test("invalid native proposal responses cannot create a review or enable capture", () => {
  expect(reviewed({ capture_enabled: true, proposals: [] })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: "corrupt" })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: [{ format: "raya.memory.proposal.v1" }] })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: [] })).toEqual({ capture_enabled: false, proposals: [] })
})

test("review accepts the complete bounded ledger and refuses overflow or a malformed boundary row", () => {
  const rows = Array.from({ length: 128 }, (_, index) => ({
    format: "raya.memory.proposal.v1",
    id: index.toString(16).padStart(32, "0"),
    project: "C:/work/raya",
    digest: "a".repeat(64),
    status: "pending",
    capture_enabled: false,
    provenance: "Source-backed fixture",
    sources: [{ path: "C:/work/raya/source.md", sha256: "b".repeat(64), kind: "markdown", event_time: null }],
    changes: [{ path: "Preferences/lights.md", expected: null, before: null, content: "Use a slow cycle." }],
  }))
  expect(reviewed({ capture_enabled: false, proposals: rows })).toEqual({ capture_enabled: false, proposals: rows })
  expect(reviewed({ capture_enabled: false, proposals: [...rows, rows[0]] })).toBeUndefined()
  expect(
    reviewed({ capture_enabled: false, proposals: [...rows.slice(0, 127), { ...rows[127], changes: null }] }),
  ).toBeUndefined()
})
