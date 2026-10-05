import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { snapshot } from "../../src/kilocode/migration/profile-bundle"
import { historicalDigest } from "../../src/kilocode/migration/profile-restored-evidence"
import { restoredSources } from "../../src/kilocode/migration/profile-restored-source-schema"
import { validateRestoredSources } from "../../src/kilocode/migration/profile-restored-source-correspondence"

test("compact original writer references preserve ordered strict archives without recursive snapshots", () => {
  const archives = Array.from({ length: 3 }, () =>
    snapshot.parse({
      format: "raya.profile-data",
      version: 1,
      id: randomUUID(),
      createdAt: 1,
      schema: "a".repeat(64),
      workspaces: [],
      sql: [],
      json: [],
      review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
    }),
  )
  const text = JSON.stringify({ ...archives[0], archives: archives.slice(1) })
  const value = {
    archive: archives[0].id,
    archiveDigest: historicalDigest(archives[0]),
    prior: archives.slice(1).map((entry) => ({ archive: entry.id, archiveDigest: historicalDigest(entry) })),
    bytes: Buffer.byteLength(text),
    digest: createHash("sha256").update(text).digest("hex"),
  }
  validateRestoredSources([value], { archives })
  expect(restoredSources.safeParse([value]).success).toBe(true)
  assert.throws(
    () => validateRestoredSources([{ ...value, prior: [...value.prior].reverse() }], { archives }),
    /writer bytes/,
  )
  assert.throws(() => validateRestoredSources([value], { archives: archives.slice(0, 2) }), /archive/)
  assert.throws(() => validateRestoredSources([value], { archives: [...archives, archives[0]] }), /archive/)
  assert.throws(() => validateRestoredSources([{ ...value, archiveDigest: "0".repeat(64) }], { archives }), /archive/)
  expect(
    restoredSources.safeParse([{ ...value, prior: [{ archive: value.archive, archiveDigest: value.archiveDigest }] }])
      .success,
  ).toBe(false)
  expect(restoredSources.safeParse([{ ...value, prior: [value.prior[0], value.prior[0]] }]).success).toBe(false)
  expect(restoredSources.safeParse([value, value]).success).toBe(false)
  expect(restoredSources.safeParse([{ ...value, bytes: 128 * 1024 * 1024 + 1 }]).success).toBe(false)
})
