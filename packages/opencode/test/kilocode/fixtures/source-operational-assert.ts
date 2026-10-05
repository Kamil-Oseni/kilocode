import assert from "node:assert/strict"
import { payload } from "../../../src/kilocode/migration/profile-bundle"
import { operational, operationalPolicy } from "../../../src/kilocode/migration/profile-operational-schema"
import { validateOperational } from "../../../src/kilocode/migration/profile-operational-correspondence"

export function verifyOperational(raw: unknown) {
  const bundle = payload.parse(raw)
  const value = operational.parse(bundle.operational)
  assert(bundle.disposition)
  const groups = bundle.disposition.files.filter((entry) => entry.disposition.kind === "operational-policy")
  assert.equal(groups.length, value.entries.length)
  for (const file of groups) {
    const entry = operationalPolicy.parse(file.disposition)
    validateOperational(entry, { operational: value })
    assert.equal(entry.rawBytesPreserved, false)
    assert.equal(file.path, entry.source)
    assert.equal(file.digest, entry.digest)
    assert.equal(file.bytes, entry.bytes)
    assert.equal(file.dev, entry.dev)
    assert.equal(file.ino, entry.ino)
  }
  for (const role of ["storage-migration", "telemetry-identity", "legacy-diagnostics", "effect-diagnostics"])
    assert(value.entries.some((entry) => entry.role === role))
  assert(!JSON.stringify(value).includes("PRIVATE_OPERATIONAL_DIAGNOSTIC_DO_NOT_TRANSFER"))
  return {
    entries: value.entries.length,
    rawDiagnosticsTransferred: false,
    telemetryIdentityReplayed: false,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  }
}
