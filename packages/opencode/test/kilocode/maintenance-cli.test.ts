import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { maintenance } from "../../src/kilocode/migration/maintenance-process"

test("source CLI maintenance route joins outer retirement without ordinary bootstrap or source mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-maintenance-cli-"))
  const storage = path.join(root, "storage")
  const database = path.join(root, "source.db")
  await mkdir(storage)
  await writeFile(path.join(storage, "marker.json"), '{"unchanged":true}')
  const db = new Database(database)
  try {
    db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('untouched source')")
  } finally {
    db.close()
  }
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(database))
      .digest("hex")
  const before = await digest()
  const password = "RAYA_PRIVATE_STDIN_ONLY_PASSPHRASE"
  const result = await maintenance({
    roots: [
      { kind: "sqlite", path: database },
      { kind: "json", path: storage },
    ],
    source: { database, storage },
    password,
    command: [
      process.execPath,
      "run",
      "--conditions=browser",
      path.join(import.meta.dir, "../../src/index.ts"),
      "__profile-maintenance",
    ],
  })
  expect(result.code).toBe(1)
  expect(result.forced).toBe(false)
  expect(result.receipt.result).toEqual({ ok: false, reason: "coverage-incomplete" })
  expect(JSON.stringify(result.receipt)).not.toContain(password)
  expect(await digest()).toBe(before)
  expect(await readFile(path.join(storage, "marker.json"), "utf8")).toBe('{"unchanged":true}')
  expect(
    await stat(path.join(result.privateRoot, "unused.db")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(await readFile(path.join(result.privateRoot, "stderr.log"), "utf8")).not.toContain(password)
}, 45_000)
