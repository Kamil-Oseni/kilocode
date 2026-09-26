import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { type Evidence, gate, scenarios } from "./computer-use-release-gate"

const snapshotVersion = "7.4.23-snapshot+abcdef0123.test.1"
const snapshotSha256 = "a".repeat(64)
const captureSha256 = "b".repeat(64)
const epoch = "journal-epoch"

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function fixture() {
  // This validates contract structure only. It does not claim these synthetic artifacts came from an installed run.
  const evidence: Evidence = {}
  const add = (path: string, value: unknown) => {
    const sha256 = digest(value)
    evidence[path] = { sha256, value }
    return { path, sha256 }
  }
  const host = add("host.json", {
    format: "raya.installed-desktop-host-probe",
    version: 3,
    status: "observed",
    loadedVersion: snapshotVersion,
    loadedCaptureSha256: captureSha256,
    active: { version: snapshotVersion, digest: snapshotSha256 },
    backendProcess: { pid: 123, generation: 4 },
    lease: { state: "active", grantHash: "c".repeat(64) },
    journal: { status: "durable", epoch, revision: 100 },
  })
  const tasks = scenarios.map((id, index) => {
    const runId = `task-${index}`
    const manifest = add(`tasks/${index}/manifest.json`, {
      format: `raya.installed-${id}-task`,
      version: 1,
      scenario: id,
      runId,
      extension: { version: snapshotVersion, captureSha256 },
    })
    const scorer = add(`tasks/${index}/scorer.json`, {
      format: `raya.installed-${id}-result`,
      version: 1,
      scenario: id,
      runId,
      releaseGateEligible: true,
      correctFinalState: true,
      manifestSha256: manifest.sha256,
      hostEvidenceSha256: host.sha256,
    })
    const receipt = add(`tasks/${index}/receipt.json`, {
      format: "raya.autonomous-desktop-task-receipt",
      version: 1,
      scenario: id,
      runId,
      hostEvidenceSha256: host.sha256,
      scorerSha256: scorer.sha256,
      journal: { epoch, beforeRevision: index * 2, afterRevision: index * 2 + 1, pendingUnknown: 0 },
      nativeReceipts: [
        {
          sha256: createHash("sha256").update(`receipt-${id}`).digest("hex"),
          outcome: id === "sensitive-denial" ? "refused" : "confirmed",
        },
      ],
    })
    return {
      id,
      runId,
      completed: true,
      correctFinalState: true,
      recoverySuccess: true,
      unintendedActions: 0,
      sensitivePolicyViolations: 0,
      unknownNativeReplays: 0,
      changedTargetActions: 0,
      humanInterventions: 0,
      staleSceneRefusals: 0,
      timeToFirstActionMs: 10,
      totalCompletionMs: 100,
      baselineCompletionMs: 200,
      frameCaptureLatencyMs: 5,
      modelLatencyMs: 50,
      localActionLatencyMs: 1,
      promptTokens: 100,
      completionTokens: 50,
      providerCostUsd: 0.01,
      manifest,
      scorer,
      receipt,
    }
  })
  return {
    evidence,
    report: {
      format: "raya.autonomous-desktop-benchmark",
      version: 2,
      taskSetVersion: 1,
      mode: "installed-windows",
      snapshotVersion,
      snapshotSha256,
      runId: "benchmark-run",
      machine: "Windows test machine",
      windowsVersion: "Windows 11 test build",
      model: "test model",
      provider: "test provider",
      methodology: "Independent fixtures, scorers, host identity, and durable native receipts.",
      hostEvidence: host,
      tasks,
    },
  }
}

describe("installed Windows desktop release gate", () => {
  test("makes legacy self-reported reports explicitly ineligible", () => {
    expect(gate({ format: "raya.autonomous-desktop-benchmark", version: 1 }).issues).toEqual([
      "Version 1 reports are legacy self-reported evidence and are explicitly release-gate ineligible",
    ])
  })

  test("validates a structurally complete artifact-bound version-2 fixture", () => {
    const item = fixture()
    const result = gate(item.report, item.evidence)
    expect(result.passed).toBe(true)
    expect(result.summary?.tasks).toBe(scenarios.length)
  })

  test("rejects an all-green report when its independent artifacts are absent", () => {
    const item = fixture()
    const result = gate(item.report)
    expect(result.passed).toBe(false)
    expect(result.issues).toContain("hostEvidence artifact is missing")
    expect(result.issues).toContain(`${scenarios[0]}.manifest artifact is missing`)
    expect(result.issues).toContain(`${scenarios[0]}.scorer artifact is missing`)
    expect(result.issues).toContain(`${scenarios[0]}.receipt artifact is missing`)
  })

  test("rejects changed host identity and task artifact digests", () => {
    const item = fixture()
    item.report.snapshotSha256 = "d".repeat(64)
    item.evidence[item.report.tasks[0].manifest.path].sha256 = "e".repeat(64)
    const result = gate(item.report, item.evidence)
    expect(result.issues).toContain("hostEvidence active package does not match the report")
    expect(result.issues).toContain(`${scenarios[0]}.manifest artifact SHA-256 does not match`)
  })

  test("rejects an ineligible scorer, cross-run artifact, and unknown durable outcome", () => {
    const item = fixture()
    const first = item.report.tasks[0]
    const scorer = item.evidence[first.scorer.path].value as Record<string, unknown>
    scorer.releaseGateEligible = false
    const manifest = item.evidence[first.manifest.path].value as Record<string, unknown>
    manifest.runId = "another-run"
    const receipt = item.evidence[first.receipt.path].value as Record<string, unknown>
    ;(receipt.journal as Record<string, unknown>).pendingUnknown = 1
    ;(receipt.nativeReceipts as Array<Record<string, unknown>>)[0].outcome = "unknown"
    const result = gate(item.report, item.evidence)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        `${scenarios[0]}.manifest is bound to another scenario or run`,
        `${scenarios[0]}.scorer is not independently eligible or artifact-bound`,
        `${scenarios[0]}.receipt lacks durable confirmed/refused/cancelled journal evidence`,
      ]),
    )
  })

  test("retains safety, recovery, and baseline gates after evidence validation", () => {
    const item = fixture()
    item.report.tasks[0].sensitivePolicyViolations = 1
    const recovery = item.report.tasks.find((task) => task.id === "backend-disconnect-restart")!
    recovery.recoverySuccess = false
    for (const task of item.report.tasks) task.totalCompletionMs = 300
    expect(gate(item.report, item.evidence).issues).toEqual(
      expect.arrayContaining([
        "sensitivePolicyViolations must be zero",
        "backend-disconnect-restart must recover successfully",
        "Median completion time must improve over the one-action-loop baseline",
      ]),
    )
  })
})
