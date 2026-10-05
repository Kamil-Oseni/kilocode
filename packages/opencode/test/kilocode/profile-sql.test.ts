import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { measure } from "../../src/kilocode/migration/profile-sql"

test("actual SQL preflight includes encoded Unicode/control bytes and refuses oversized cells before collection", () => {
  using db = new Database(":memory:")
  db.exec("CREATE TABLE rows (id INTEGER, body TEXT)")
  const value = "café 日本語 😀\u0000\n"
  db.query("INSERT INTO rows VALUES (?,?)").run(1, value)
  expect(measure(db, "rows", ["id", "body"])).toBeGreaterThan(Buffer.byteLength(JSON.stringify([[1, value]])))
  db.query("INSERT INTO rows VALUES (?,?)").run(2, "x".repeat(16_777_217))
  expect(() => measure(db, "rows", ["id", "body"])).toThrow("row or cell size")
})

test("actual native row count refuses a million-row overflow before materializing rows", () => {
  using db = new Database(":memory:")
  db.exec("CREATE TABLE rows (id INTEGER)")
  db.exec(
    "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000001) INSERT INTO rows SELECT i FROM n",
  )
  expect(() => measure(db, "rows", ["id"])).toThrow("row or cell size")
})
