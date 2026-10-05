import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { acquireProfileRoot, admitProfileOperation } from "../../src/kilocode/profile-maintenance"
import { profileSqlite } from "../../src/kilocode/profile-sqlite"

const dir = process.argv.at(-2)!
const mode = process.argv.at(-1)!
const roots = ["first", "second"].map((name) => ({ kind: "json" as const, path: path.join(dir, name) }))
async function wait() {
  await writeFile(path.join(dir, "ready"), String(process.pid))
  const stop = performance.now() + 10_000
  while (!(await Bun.file(path.join(dir, "release")).exists())) {
    if (performance.now() >= stop) throw new Error("Accepted root write release deadline elapsed")
    await Bun.sleep(10)
  }
}
async function run() {
  if (mode === "native") {
    const owners = roots.map((root) => {
      const file = path.join(root.path, "owned.db")
      const db = profileSqlite(file, () => new Database(file))
      db.run("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('durable')")
      return db
    })
    try {
      await wait()
    } finally {
      for (const owner of owners) owner.close()
    }
    console.log(JSON.stringify({ closed: true }))
    return
  }
  if (mode === "late") {
    for (const root of roots) {
      await assert.rejects(acquireProfileRoot(root, { timeoutMs: 150 }), /Timed out/)
      assert.throws(() => admitProfileOperation(root), /maintenance excludes/)
    }
    console.log(JSON.stringify({ excluded: true }))
    return
  }
  if (mode === "nested") {
    const outer = await acquireProfileRoot(roots[1])
    await writeFile(path.join(dir, "ready"), String(process.pid))
    while (!(await Bun.file(path.join(dir, "child")).exists())) await Bun.sleep(5)
    const opts = {
      timeoutMs: 5000,
      onWait: async () => {
        await writeFile(path.join(dir, "waiting"), "actual-gate-wait")
      },
    }
    const inner = await acquireProfileRoot(roots[0], opts)
    await writeFile(path.join(roots[0].path, "value.json"), JSON.stringify({ value: 0 }))
    await writeFile(path.join(roots[1].path, "value.json"), JSON.stringify({ value: 1 }))
    await inner.release()
    await outer.release()
    console.log(JSON.stringify({ nested: true, published: true }))
    return
  }
  assert.equal(mode, "accepted")
  const leases = roots.map(admitProfileOperation)
  try {
    await wait()
    for (const [index, root] of roots.entries()) {
      await writeFile(path.join(root.path, "value.json"), JSON.stringify({ value: index }))
      leases[index].release()
    }
    console.log(JSON.stringify({ published: true }))
  } catch (err) {
    console.error("Accepted root writes failed", err)
    throw err
  }
}
await run()
