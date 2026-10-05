import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { payload } from "../../../src/kilocode/migration/profile-bundle"
import { validateGitMetadata } from "../../../src/kilocode/migration/profile-git-metadata-correspondence"

/** Inspect a genuine decrypted Source result; this helper cannot create capture authority. */
export async function assertGitMetadataSource(input: unknown, originals = false) {
  const value = payload.parse(input)
  assert(value.disposition, "Actual Source disposition is required")
  const files = value.disposition.files.filter((file) => file.disposition.kind === "git-metadata")
  assert(files.length > 0, "Actual Source Git metadata is required")
  const content = { artifacts: value.artifacts, secondary: value.secondary }
  const totals = { files: 0, configs: 0, pointers: 0, admin: 0, omissions: 0, originalBytesVerified: 0 }
  const admin = new Set<string>()
  for (const file of files) {
    const entry = file.disposition
    if (entry.kind !== "git-metadata") throw new Error("Actual Git metadata selector changed")
    validateGitMetadata(entry, content)
    assert.equal(entry.source, file.path)
    assert.equal(entry.dev, file.dev)
    assert.equal(entry.ino, file.ino)
    assert.equal(entry.bytes, file.bytes)
    assert.equal(entry.digest, file.digest)
    assert.equal(entry.activation, "inert")
    if (originals) {
      const bytes = await readFile(file.path)
      assert.equal(bytes.length, entry.bytes)
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.digest)
      totals.originalBytesVerified++
    }
    totals.files++
    if (entry.selector.kind === "config") {
      totals.configs++
      assert.equal(entry.transformation, "safe-config-projection")
      assert.equal(entry.rawBytesPreserved, false)
      assert(entry.ledger.every((line, index) => line.line === index))
      totals.omissions += entry.ledger.filter((line) => line.reason.startsWith("omitted-")).length
    }
    if (entry.selector.kind === "pointer") {
      totals.pointers++
      assert.equal(entry.transformation, "mapped-backlink")
      assert.equal(entry.rawBytesPreserved, false)
    }
    if (entry.selector.kind === "admin") {
      totals.admin++
      admin.add(entry.selector.path)
      assert.equal(entry.rawBytesPreserved, true)
    }
  }
  assert(totals.configs > 0, "Actual Source safe Git config provenance is required")
  assert(totals.pointers > 0, "Actual Source mapped managed-worktree pointer is required")
  for (const field of ["HEAD", "index", "logs/HEAD", "gitdir", "commondir"])
    assert(admin.has(field), "Actual Source finite admin evidence is required")
  return Object.freeze({
    ...totals,
    adminFields: Object.freeze([...admin].sort()),
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    scope:
      "Genuine decrypted Source metadata with exact native inventory/component provenance; raw admin archive evidence remains inert and active backlinks are regenerated. No capability is minted by serialized data.",
  })
}
