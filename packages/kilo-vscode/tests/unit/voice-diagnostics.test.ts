import { expect, test } from "bun:test"
import { diagnostics, type PlaybackDiagnostic } from "../../src/speech/diagnostics"

test("diagnostics keep finite whitelisted metadata and reject arbitrary content", () => {
  const rows: PlaybackDiagnostic[] = []
  const trace = diagnostics("private-invalid-request", (row) => rows.push(row))
  const fields = {
    job: "private-job",
    bytes: -1,
    rate: Infinity,
    text: "private prompt",
    key: "private credential",
    data: "private audio",
  }
  for (let index = 0; index < 200; index++) trace("chunk", fields)
  expect(rows).toHaveLength(128)
  expect(rows.every((row) => Object.keys(row).sort().join() === "elapsed,phase,request")).toBe(true)
  expect(rows.every((row) => row.request === "unavailable")).toBe(true)
  expect(JSON.stringify(rows)).not.toContain("private")
})

test("diagnostic observer failure cannot interrupt a playback owner", () => {
  const trace = diagnostics("9a1d6a7d-8387-4381-b9bf-e7bfda2d66c3", () => {
    throw new Error("private observer failure")
  })
  expect(() => trace("start")).not.toThrow()
})

test("diagnostics retain bounded playback UUID and provider request ID separately", () => {
  const rows: PlaybackDiagnostic[] = []
  for (const request of ["9a1d6a7d-8387-4381-b9bf-e7bfda2d66c3", "req_d649f5e4-9ea0-4b47-ba6b-777e0433dc5c"])
    diagnostics(request, (row) => rows.push(row))("start")
  expect(rows.map((row) => row.request)).toEqual([
    "9a1d6a7d-8387-4381-b9bf-e7bfda2d66c3",
    "req_d649f5e4-9ea0-4b47-ba6b-777e0433dc5c",
  ])
})
