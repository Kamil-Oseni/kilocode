import { expect, test } from "bun:test"
import path from "node:path"
import { review } from "../../src/second-brain/committed-capture"
import { command } from "../../src/second-brain/control/command"
import { release } from "../../src/second-brain/control/catalog-capture"
import { interpreter, supervisor } from "../../src/second-brain/managed/catalog"
import { fingerprint } from "../../src/second-brain/failed-repair"

test("committed capture review verifies actual journals without writes and rejects changed evidence", async () => {
  const value = await command(
    "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
    ["-B", path.resolve("script/memory/capture_recovery_test.py")],
    { cwd: process.cwd() },
  )
  expect(value.stdout).toBe("")
  expect(value.stderr).toContain("Ran 4 tests")
  expect(value.stderr).toContain("OK")
  expect(value.receipt).toMatchObject({
    code: 0,
    stdoutEOF: true,
    stderrEOF: true,
    originalJoined: true,
    readersJoined: true,
    observationExpired: false,
    forced: false,
  })
}, 15000)

test("committed capture review refuses substituted retained selections before execution", async () => {
  const root = "C:\\Synthetic\\Notes"
  const dir = "C:\\Synthetic\\raya-memory-managed-capture"
  const ref = (name: string, sha256: string) => ({ path: path.join(dir, name), bytes: 1, sha256 })
  const space = (kind: string) => ({
    root: path.join(dir, kind),
    sid: "S-1-5-21-1-2-3-1001",
    generations: { root: ["1", "2", "3"], Runs: ["4", "5", "6"], Requests: ["7", "8", "9"] },
  })
  const entry = {
    setup: {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v2",
      origin: "http://127.0.0.1:8874",
      root,
      source_sha256: release,
    },
    managed: {
      format: "raya.memory.managed.launch",
      version: 2,
      root: dir,
      python: ref("python.exe", interpreter),
      supervisor: ref("supervise.py", supervisor),
      plan: ref("memory.json", "a".repeat(64)),
      retrieval: ref("retrieval.json", "b".repeat(64)),
      namespaces: { memory: space("memory"), retrieval: space("retrieval") },
    },
    launch: { phase: "uncertain" },
  }
  const debt = {
    format: "raya.memory.control.uncertainty",
    version: 2,
    protocol: "raya.memory.operation.v2",
    root,
    request: {
      op: "capture",
      id: "a".repeat(32),
      root,
      owner_epoch: "b".repeat(32),
      selected_release_sha256: fingerprint(release),
      bodySHA: "c".repeat(64),
      source_sha256: release,
    },
  }
  const turn = {
    id: "11111111-1111-5111-8111-111111111111",
    project: "C:\\Synthetic\\Workspace",
    sessionID: "original-session",
    messageID: "original-message",
    source_sha256: "d".repeat(64),
    root,
    release: fingerprint(release),
    phase: "uncertain",
  }
  await expect(review(process.cwd(), entry, debt, turn)).rejects.toThrow("pair phase required")
  await expect(review(process.cwd(), entry, debt, { ...turn, phase: "published" })).rejects.toThrow()
  await expect(review(process.cwd(), entry, debt, { ...turn, root: root + "-other" })).rejects.toThrow(
    "selection required",
  )
  await expect(
    review(process.cwd(), entry, { ...debt, request: { ...debt.request, op: "search" } }, turn),
  ).rejects.toThrow("selection required")
  await expect(review(process.cwd(), entry, debt, { ...turn, release: "0".repeat(64) })).rejects.toThrow(
    "selection required",
  )
})
