import { expect, test } from "bun:test"
import { groups, project, reason, reviewed } from "../../webview-ui/src/components/settings/brain-proposal-state"
import type { BrainProposal } from "../../src/shared/second-brain"

test("explanations require the selected revision and bounded plain-text reasons", () => {
  const proposal: BrainProposal = {
    format: "raya.memory.proposal.v1",
    id: "original",
    project: "C:/work/raya",
    digest: "a".repeat(64),
    status: "pending",
    capture_enabled: false,
    provenance: "Source",
    sources: [{ path: "C:/work/raya/source.md", sha256: "b".repeat(64), kind: "document", event_time: null }],
    changes: [{ path: "Preferences/lights.md", expected: null, before: null, content: "Slow cycle." }],
  }
  const detail = {
    id: proposal.id,
    digest: proposal.digest,
    fingerprint: "c".repeat(64),
    kind: "hypothesis",
    rationale: "Source-based suggestion",
    contradictions: ["Needs human review"],
  }
  expect(reason(detail, proposal)).toBe(detail)
  for (const value of [
    undefined,
    { ...detail, id: "other" },
    { ...detail, digest: "d".repeat(64) },
    { ...detail, fingerprint: "invalid" },
    { ...detail, kind: "verified" },
    { ...detail, rationale: " " },
    { ...detail, rationale: "a".repeat(8001) },
    { ...detail, contradictions: null },
    { ...detail, contradictions: [7] },
    { ...detail, contradictions: [" "] },
    { ...detail, contradictions: ["a".repeat(8001)] },
    { ...detail, contradictions: Array(17).fill("conflict") },
  ])
    expect(reason(value, proposal)).toBeUndefined()
})

test("review groups retain the original proposal identities and keep unresolved writes distinct from publication", () => {
  const rows: BrainProposal[] = (["applied", "pending", "cancelled", "applying", "pending"] as const).map(
    (status, index) => ({
      format: "raya.memory.proposal.v1",
      id: `proposal-${index}`,
      project: "C:/work/raya",
      digest: "a".repeat(64),
      status,
      capture_enabled: false,
      provenance: "Reviewed source",
      sources: [{ path: "C:/work/raya/source.md", sha256: "b".repeat(64), kind: "document", event_time: null }],
      changes: [{ path: "Preferences/lights.md", expected: null, before: null, content: "Slow cycle." }],
    }),
  )
  const result = groups(rows)
  expect(result.map((group) => group.title)).toEqual([
    "Awaiting review",
    "Needs reconciliation",
    "Published changes",
    "Discarded proposals",
  ])
  expect(result[0].items).toEqual([rows[1], rows[4]])
  expect(result[1].items[0]).toBe(rows[3])
  expect(result[2].items[0]).toBe(rows[0])
  expect(result.flatMap((group) => group.items)).toHaveLength(rows.length)
  expect(groups([])).toEqual([])
  expect(rows.map((row) => row.id)).toEqual(["proposal-0", "proposal-1", "proposal-2", "proposal-3", "proposal-4"])
})

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
    sources: [{ path: "C:/work/raya/source.md", sha256: "b".repeat(64), kind: "document", event_time: null }],
    changes: [{ path: "Preferences/lights.md", expected: null, before: null, content: "Use a slow cycle." }],
  }))
  expect(reviewed({ capture_enabled: false, proposals: rows })).toEqual({ capture_enabled: false, proposals: rows })
  expect(reviewed({ capture_enabled: false, proposals: [...rows, rows[0]] })).toBeUndefined()
  expect(
    reviewed({ capture_enabled: false, proposals: [...rows.slice(0, 127), { ...rows[127], changes: null }] }),
  ).toBeUndefined()
  expect(reviewed({ ...rows[0], sources: [{ ...rows[0].sources[0], kind: "unvalidated" }] })).toBeUndefined()
  expect(reviewed({ ...rows[0], sources: [{ ...rows[0].sources[0], event_time: 4 }] })).toBeUndefined()
  expect(reviewed({ ...rows[0], sources: [] })).toBeUndefined()
})
