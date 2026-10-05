import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { payload } from "../../../src/kilocode/migration/profile-bundle"
import { memoryDerived, validateMemoryDerived } from "../../../src/kilocode/migration/profile-memory-derived"

/** Inspect actual decrypted evidence only; serialized records never mint capture authority. */
export async function assertMemoryDerivedSource(input: unknown, originals = false) {
  const value = payload.parse(input)
  assert(value.disposition)
  const files = value.disposition.files.filter((file) => memoryDerived.safeParse(file.disposition).success)
  assert(files.length > 0, "Actual Source scaffold correspondence required")
  const totals = { files: 0, index: 0, ignore: 0, originalBytesVerified: 0 }
  for (const file of files) {
    const entry = memoryDerived.parse(file.disposition)
    validateMemoryDerived(entry, value)
    assert.equal(entry.source, file.path)
    assert.equal(entry.dev, file.dev)
    assert.equal(entry.ino, file.ino)
    assert.equal(entry.bytes, file.bytes)
    assert.equal(entry.digest, file.digest)
    assert.equal(entry.sourceTimestampAuthority, false)
    assert.equal(entry.activation, "inert")
    totals.files++
    totals[entry.selector]++
    if (!originals) continue
    const stat = await lstat(file.path, { bigint: true })
    const bytes = await readFile(file.path)
    assert.equal(String(stat.dev), entry.dev)
    assert.equal(String(stat.ino), entry.ino)
    assert.equal(bytes.length, entry.bytes)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.digest)
    totals.originalBytesVerified++
  }
  assert(totals.ignore > 0)
  return {
    ...totals,
    qualifier:
      "Exact source bytes match actual held-stage renderer or standard scaffold; original timestamps unavailable, nonmatching indexes remain unknown.",
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  }
}
