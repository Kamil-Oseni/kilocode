import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { payload } from "../../../src/kilocode/migration/profile-bundle"
import { validateVoice } from "../../../src/kilocode/migration/profile-voice-reconciliation"
import { voice } from "../../../src/kilocode/migration/profile-voice-reconciliation-schema"
import type z from "zod"

export async function verifyVoice(
  input: unknown,
  originals = false,
  baseline?: { cycle: number; status: string; scanned: number; receipts: number },
) {
  const value = payload.parse(input)
  assert(value.voice && value.disposition)
  assert.equal(value.voice.states.length, 1)
  const groups = value.disposition.files.filter((entry) => entry.disposition.kind === "voice-reconciliation")
  assert.equal(groups.length, 1)
  for (const file of groups) {
    assert.equal(file.disposition.kind, "voice-reconciliation")
    if (file.disposition.kind !== "voice-reconciliation") throw new Error("Voice Source classification missing")
    validateVoice(file.disposition, { voice: value.voice })
    assert.equal(file.disposition.source, file.path)
    assert.equal(file.disposition.dev, file.dev)
    assert.equal(file.disposition.ino, file.ino)
    assert.equal(file.disposition.digest, file.digest)
    assert.equal(file.disposition.bytes, file.bytes)
    if (originals) assert.equal(await readFile(file.path, "utf8"), value.voice.states[0].original)
  }
  const state = value.voice.states[0].state
  assert.equal(state.status, "complete")
  assert(baseline, "Actual Source seed publication is required")
  assert.equal(baseline.cycle, 1)
  assert.equal(baseline.status, "complete")
  assert.equal(baseline.scanned, 0)
  assert.equal(baseline.receipts, 0)
  // One HTTP voice layer runs the shipped startup reconciliation after the seed.
  assert.equal(state.cycle, baseline.cycle + 1)
  assert.equal(state.receipts, 0)
  assert.equal(state.scanned, 0)
  return Object.freeze({
    actualWriter: "voice.make/reconcile/nativeStorage",
    states: 1,
    nativeClaims: 1,
    originalReadback: originals,
    sourceReceipts: 0,
    activation: "inert",
    seedCycle: baseline.cycle,
    retiredCycle: state.cycle,
    actualHTTPStartupReconciliation: true,
    settlementReplay: false,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  })
}
export async function verifyVoiceRestored(dir: string, input: z.output<typeof voice>) {
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "restore-voice-reconciliation.json"), "utf8")), input)
  assert.equal(await Bun.file(path.join(dir, "storage/raya/voice/usage-reconciliation/v1.json")).exists(), false)
  assert.equal(await Bun.file(path.join(dir, "storage/raya/voice-reconciliation")).exists(), false)
  assert.equal(JSON.parse(await readFile(path.join(dir, "storage/raya/restore-hold.json"), "utf8")).state, "held")
}
