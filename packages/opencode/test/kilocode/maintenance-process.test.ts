import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { maintenance } from "../../src/kilocode/migration/maintenance-process"
import { authenticate, request, sign } from "../../src/kilocode/migration/maintenance-protocol"

test("authenticated private maintenance process refuses incomplete coverage and exits naturally without source mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-maintenance-source-"))
  const storage = path.join(root, "storage")
  await mkdir(storage)
  await writeFile(path.join(storage, "marker.json"), '{"untouched":true}')
  const config = path.join(root, "raya.jsonc")
  const modelState = path.join(root, "model.json")
  const extensionState = path.join(root, "extension.json")
  const exports = path.join(root, "session-export.db")
  for (const file of [config, modelState, extensionState]) await writeFile(file, "{}")
  await writeFile(exports, "private export marker")
  const database = path.join(root, "raya.db")
  const db = new Database(database)
  db.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES ('source marker')")
  db.close()
  const before = createHash("sha256")
    .update(await readFile(database))
    .digest("hex")
  const keys = [
    "RAYA_DAEMON_GENERATION",
    "RAYA_DAEMON_RECEIPT",
    "RAYA_SOURCE_HOST_PID",
    "RAYA_CONTROLLER_RUN",
    "RAYA_HOST_PID",
    "RAYA_PARENT_GENERATION",
  ]
  const prior = keys.map((key) => process.env[key])
  for (const key of keys) process.env[key] = "synthetic inherited host identity"
  const result = await (async () => {
    try {
      return await maintenance({
        roots: [
          { kind: "sqlite", path: database },
          { kind: "json", path: storage },
        ],
        source: { database, storage, preferences: { config, modelState, extensionState }, exports },
        password: "private channel test passphrase",
        command: [process.execPath, path.join(import.meta.dir, "fixtures/maintenance-isolation.ts")],
      })
    } finally {
      keys.forEach((key, index) => {
        if (prior[index] === undefined) delete process.env[key]
        else process.env[key] = prior[index]
      })
    }
  })()
  expect(result.receipt.result).toEqual({ ok: false, reason: "coverage-incomplete" })
  expect(result.code).toBe(1)
  expect(result.forced).toBe(false)
  expect(result.privateRoot).not.toBe(root)
  expect(Object.values(result.receipt.environment).every((file) => file.startsWith(result.privateRoot))).toBe(true)
  expect(await Bun.file(result.receipt.environment.database).exists()).toBe(false)
  expect(JSON.stringify(result)).not.toContain("private channel test passphrase")
  expect(() => process.kill(result.pid, 0)).toThrow()
  expect(
    createHash("sha256")
      .update(await readFile(database))
      .digest("hex"),
  ).toBe(before)
  expect(await readFile(path.join(storage, "marker.json"), "utf8")).toBe('{"untouched":true}')
  for (const file of [config, modelState, extensionState]) expect(await readFile(file, "utf8")).toBe("{}")
  expect(await readFile(exports, "utf8")).toBe("private export marker")
}, 15_000)

test("maintenance channel authenticates exact request and rejects altered roots or claimed completeness", async () => {
  const secret = randomBytes(32).toString("hex")
  const root = os.tmpdir()
  const body = request.parse({
    format: "raya.maintenance-request",
    version: 1,
    generation: crypto.randomUUID(),
    id: crypto.randomUUID(),
    roots: [{ kind: "json", path: root }],
    source: {
      database: path.join(root, "private.db"),
      storage: root,
      preferences: { modelState: path.join(root, "model.json") },
      exports: path.join(root, "session-export.db"),
    },
    password: "private channel test passphrase",
  })
  const digest = sign(body, secret)
  expect(authenticate(body, secret, digest)).toEqual(body)
  assert.throws(() => authenticate({ ...body, roots: [] }, secret, digest), /authentication/)
  assert.throws(
    () => authenticate({ ...body, source: { ...body.source, exports: path.join(root, "changed.db") } }, secret, digest),
    /authentication/,
  )
  const forged = { ...body, complete: true }
  assert.throws(() => authenticate(forged, secret, sign(forged, secret)))
})
