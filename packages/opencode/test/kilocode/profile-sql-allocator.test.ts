import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { captureAllocator } from "../../src/kilocode/migration/profile-sql-allocator"
import { allocator, declaration, hash } from "../../src/kilocode/migration/profile-sql-allocator-schema"
import { semantic, validateSQL } from "../../src/kilocode/migration/profile-sql-correspondence"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("actual SQLite deleted-row high-water counters remain inert and exact", () => {
  const db = new Database(":memory:", { strict: true })
  try {
    db.exec(declaration)
    db.exec(
      "INSERT INTO raya_composer_draft(id,workspace,project,box,record,content_bytes,metadata_bytes) VALUES ('a','w','p','b','{}',2,0),('b','w','p','b','{}',2,0); DELETE FROM raya_composer_draft WHERE sequence=2",
    )
    const value = captureAllocator(db, "1".repeat(64))
    expect(value).toBeDefined()
    expect(value?.rows).toEqual([{ name: "raya_composer_draft", seq: 2, highwater: 1 }])
    expect(value?.installation).toBe(false)
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(raya_composer_draft)")
      .all()
      .map((row) => row.name)
    const sql = [
      { table: "raya_composer_draft", columns, rows: db.query("SELECT * FROM raya_composer_draft").values() },
    ]
    const group = semantic.parse({
      kind: "sqlite-semantic",
      source: "fixture.db",
      component: "sql",
      digest: hash(sql),
      schema: "1".repeat(64),
      tables: [
        { table: "raya_composer_draft", columns, rows: 1, disposition: "selected", excluded: [] },
        {
          table: "sqlite_sequence",
          columns: ["name", "seq"],
          rows: 1,
          disposition: "inactive-allocator-counters",
          excluded: [],
        },
      ],
      complete: true,
      recovery: "private-sqlite-checkpoint",
      rawBytesPreserved: false,
      allocator: value,
    })
    expect(() => validateSQL(group, { sql })).not.toThrow()
    const changed = [{ name: "raya_composer_draft" as const, seq: 2, highwater: 0 }]
    expect(() =>
      validateSQL({ ...group, allocator: { ...value!, rows: changed, digest: hash(changed) } }, { sql }),
    ).toThrow()
    expect(semantic.safeParse({ ...group, schema: "2".repeat(64) }).success).toBe(false)
    expect(
      semantic.safeParse({
        ...group,
        tables: group.tables.map((row) => (row.table === "sqlite_sequence" ? { ...row, rows: 2 } : row)),
      }).success,
    ).toBe(false)
    const legacy = semantic.parse({
      ...group,
      allocator: undefined,
      complete: false,
      tables: group.tables.map((row) =>
        row.table === "sqlite_sequence" ? { ...row, disposition: "unclassified" } : row,
      ),
    })
    expect(legacy.complete).toBe(false)
    expect(allocator.safeParse({ ...value, digest: "0".repeat(64) }).success).toBe(false)
    const rows = [{ name: "raya_composer_draft", seq: 0, highwater: 1 }]
    expect(allocator.safeParse({ ...value, rows, digest: hash(rows) }).success).toBe(false)
    db.exec("INSERT INTO sqlite_sequence VALUES ('unknown',5)")
    expect(captureAllocator(db, "1".repeat(64))).toBeUndefined()
  } finally {
    db.close()
  }
})

test("duplicate, unsafe and mismatched allocator generations remain unclassified", () => {
  const db = new Database(":memory:", { strict: true })
  try {
    db.exec(declaration)
    expect(captureAllocator(db, "1".repeat(64))?.rows).toEqual([])
    db.exec("INSERT INTO sqlite_sequence VALUES ('raya_composer_draft',9007199254740992)")
    expect(captureAllocator(db, "1".repeat(64))).toBeUndefined()
    db.exec(
      "DELETE FROM sqlite_sequence; INSERT INTO sqlite_sequence VALUES ('raya_composer_draft',1),('raya_composer_draft',1)",
    )
    expect(captureAllocator(db, "1".repeat(64))).toBeUndefined()
    db.exec("DELETE FROM sqlite_sequence; CREATE TABLE custom(id INTEGER PRIMARY KEY AUTOINCREMENT)")
    expect(captureAllocator(db, "1".repeat(64))).toBeUndefined()
  } finally {
    db.close()
  }
})

test("actual Core graph counter is bound to a held native image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-sql-allocator-"))
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", path.join(import.meta.dir, "fixtures/profile-sql-allocator.ts"), root],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        LOCALAPPDATA: path.join(root, "local"),
        XDG_DATA_HOME: path.join(root, "unused-data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        RAYA_DB: path.join(root, "unused.db"),
        KILO_DB: path.join(root, "unused.db"),
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
      },
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await Promise.all([
    Bun.write(path.join(root, "stdout.log"), stdout),
    Bun.write(path.join(root, "stderr.log"), stderr),
  ])
  expect(code, `Retained private allocator fixture ${root}`).toBe(0)
  expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
    passed: true,
    actualCore: true,
    heldNative: true,
    deletedHighwater: true,
    installation: false,
    portableCaptureAuthorized: false,
  })
}, 60000)
