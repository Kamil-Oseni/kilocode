import assert from "node:assert/strict"
import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { payload, snapshot } from "../../src/kilocode/migration/profile-bundle"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import {
  readHistorical,
  historicalValues,
  historicalDigest,
  requireHistorical,
  type HistoricalReader,
} from "../../src/kilocode/migration/profile-restored-evidence"

test.skipIf(process.platform !== "win32")(
  "historical reader binds actual native bytes and expires with its image",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-historical-reader-")))
    const data = path.join(root, "data")
    const sibling = path.join(root, "secondary")
    const storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    await mkdir(sibling)
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const prior = snapshot.parse({
      format: "raya.profile-data",
      version: 1,
      id: crypto.randomUUID(),
      createdAt: 1,
      schema: "a".repeat(64),
      workspaces: [],
      sql: [],
      json: [],
      review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
    })
    const current = snapshot.parse({ ...prior, id: crypto.randomUUID(), createdAt: 2 })
    const secondary = snapshot.parse({ ...prior, id: crypto.randomUUID(), createdAt: 3 })
    // Explicit typed archive bytes test the reader; they do not attest to a Source export.
    const file = path.join(data, "restore-source.json")
    await writeFile(file, JSON.stringify(payload.parse({ ...current, archives: [prior] })))
    const other = path.join(sibling, "restore-source.json")
    await writeFile(other, JSON.stringify(payload.parse({ ...secondary, archives: [prior] })))
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data, sibling].sort(), files: [] }
    const selected = await select({ database, storage }, policy)
    const selection = {
      ...selected,
      roots: [...selected.roots, { kind: "json" as const, path: sibling }],
      globals: [
        {
          data,
          config: data,
          log: data,
          bin: data,
          cache: data,
          state: data,
          stateParent: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
        {
          data: sibling,
          config: sibling,
          log: sibling,
          bin: sibling,
          cache: sibling,
          state: sibling,
          stateParent: sibling,
          repos: sibling,
          homeKilocode: sibling,
          homeConfigKilo: sibling,
        },
      ],
    }
    const saved: { token?: Working; proof?: HistoricalReader } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          inventory: "directories",
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const proof = await readHistorical(token)
      saved.token = token
      saved.proof = proof
      const archives = historicalValues(token, proof)
      expect(archives.map((entry) => entry.id)).toEqual([prior.id, current.id, secondary.id])
      expect(Object.isFrozen(archives)).toBe(true)
      expect(Object.isFrozen(archives[0])).toBe(true)
      requireHistorical(token, proof, { archives })
      requireHistorical(token, proof, { archives: [...archives].reverse() })
      // Additional inert archives are not attested: callers classify only historicalValues().
      requireHistorical(token, proof, { archives: [...archives, { ...prior, id: crypto.randomUUID() }] })
      assert.throws(() => historicalValues(token, { ...proof }), /reader/)
      assert.throws(() => requireHistorical(token, proof, { archives: [current] }), /differs/)
      assert.throws(() => requireHistorical(token, proof, { archives: [...archives, prior] }), /ambiguous/)
      assert.throws(
        () => requireHistorical(token, proof, { archives: [{ ...prior, createdAt: 3 }, current] }),
        /differs/,
      )
      await assert.rejects(writeFile(file, "changed"))
    })
    assert(saved.token && saved.proof)
    assert.throws(() => historicalValues(saved.token!, saved.proof!), /expired|closed|unavailable/)
    await capture(async (token) => {
      assert.throws(() => historicalValues(token, saved.proof!), /another held image/)
      const proof = await readHistorical(token)
      expect(historicalDigest(historicalValues(token, proof)[0])).toBe(historicalDigest(prior))
    })
    await writeFile(other, JSON.stringify(payload.parse({ ...secondary, archives: [{ ...prior, createdAt: 99 }] })))
    await capture(async (token) => {
      await assert.rejects(readHistorical(token), /conflicting content/)
    })
    await writeFile(other, JSON.stringify(payload.parse({ ...secondary, archives: [prior] })))
    const archives = [
      prior,
      secondary,
      ...Array.from({ length: 61 }, () => snapshot.parse({ ...prior, id: crypto.randomUUID() })),
    ]
    await writeFile(file, JSON.stringify(payload.parse({ ...current, archives })))
    await capture(async (token) => {
      expect(historicalValues(token, await readHistorical(token))).toHaveLength(64)
    })
    await writeFile(
      file,
      JSON.stringify(payload.parse({ ...current, archives: [...archives, { ...prior, id: crypto.randomUUID() }] })),
    )
    await capture(async (token) => {
      await assert.rejects(readHistorical(token), /exceeds bound/)
    })
    await writeFile(file, JSON.stringify({ ...payload.parse({ ...current, archives: [prior] }), custom: true }))
    await capture(async (token) => {
      await assert.rejects(readHistorical(token))
    })
  },
  60000,
)

test("historical digests ignore object key order and preserve array order", () => {
  expect(historicalDigest({ a: 1, b: [2, 3] })).toBe(historicalDigest({ b: [2, 3], a: 1 }))
  expect(historicalDigest({ a: 1, b: [2, 3] })).not.toBe(historicalDigest({ a: 1, b: [3, 2] }))
})
