import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { payload, seal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"
import { globalPath } from "../../../src/kilocode/session/directory-query"

const [root, mode] = process.argv.slice(2)
assert.ok(root)
const workspace = path.join(root, mode === "source" ? "old" : "new", mode === "compat" ? "nested_%" : "nested")
const headers = { "Content-Type": "application/json", "x-kilo-directory": workspace }
const password = "private nonGit session transfer passphrase"
if (mode === "restore") {
  const result = await restore(
    await readFile(path.join(root, "bundle.json"), "utf8"),
    password,
    path.join(root, "destination"),
    { [path.join(root, "old", "nested")]: workspace },
  )
  await writeFile(path.join(root, "restored.json"), JSON.stringify(result))
} else {
  const app = Server.Default().app
  if (mode === "compat") {
    const ids: string[] = []
    for (const directory of [
      workspace,
      workspace,
      path.dirname(workspace),
      workspace,
      path.join(workspace, "child"),
      `${workspace}-sibling`,
      workspace,
    ]) {
      await mkdir(directory, { recursive: true })
      const response = await app.request("/session", {
        method: "POST",
        headers: { ...headers, "x-kilo-directory": directory },
        body: JSON.stringify({ title: "Mixed global path compatibility" }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      const value: unknown = await response.json()
      assert.ok(value && typeof value === "object" && "id" in value && typeof value.id === "string")
      ids.push(value.id)
    }
    const file = process.env.RAYA_DB
    assert.ok(file)
    const db = new Database(file)
    try {
      for (const [index, value] of [
        globalPath(workspace),
        workspace.replaceAll("\\", "/"),
        globalPath(workspace),
        "explicit-other-view",
        null,
        globalPath(workspace),
      ].entries())
        db.query("UPDATE session SET path=? WHERE id=?").run(value, ids[index])
      db.query("UPDATE session SET directory=?,path=? WHERE id=?").run(
        `Z:/${globalPath(workspace)}`,
        globalPath(workspace),
        ids[6],
      )
      for (const query of [globalPath(workspace), workspace.replaceAll("\\", "/")]) {
        const response = await app.request(
          `/session?directory=${encodeURIComponent(workspace)}&roots=true&path=${encodeURIComponent(query)}`,
          { headers },
        )
        assert.equal(response.status, 200, await response.clone().text())
        const rows: unknown = await response.json()
        assert.ok(Array.isArray(rows))
        assert.deepEqual(
          rows.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
          [ids[0], ids[1], ids[3], ids[4]].sort((a, b) => a.localeCompare(b)),
        )
      }
      const response = await app.request(
        `/session?directory=${encodeURIComponent(workspace)}&roots=true&path=explicit-other-view`,
        { headers },
      )
      assert.equal(response.status, 200, await response.clone().text())
      const rows: unknown = await response.json()
      assert.ok(Array.isArray(rows))
      assert.deepEqual(
        rows.map((row) => row.id),
        [ids[3]],
      )
      for (const table of ["session_input", "message", "part", "raya_routine_occurrence"])
        assert.equal(db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0)
    } finally {
      db.close()
    }
  } else if (mode === "source") {
    const response = await app.request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Non-Git retained chat" }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const value: unknown = await response.json()
    assert.ok(value && typeof value === "object" && "id" in value && typeof value.id === "string")
    const file = process.env.RAYA_DB
    assert.ok(file)
    const db = new Database(file, { readonly: true })
    try {
      const session = db
        .query<
          { project_id: string; directory: string; path: string },
          [string]
        >("SELECT project_id,directory,path FROM session WHERE id=?")
        .get(value.id)
      assert.ok(session)
      assert.equal(session?.project_id, "global")
      assert.equal(path.resolve(session.directory), path.resolve(workspace))
      assert.equal(session.path, path.relative(path.resolve("/"), workspace).replaceAll("\\", "/"))
      assert.ok(session.path)
      const sql = tables.map((table) => ({
        table,
        columns: db
          .query<Column, []>(`PRAGMA table_info('${table}')`)
          .all()
          .map((column) => column.name),
        rows: db.query(`SELECT * FROM "${table}"`).values(),
      }))
      const schema = Effect.runSync(signature((query) => Effect.sync(() => db.query<Column, []>(query).all())))
      const bundle = await seal(
        payload.parse({
          format: "raya.profile-data",
          version: 1,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          schema,
          workspaces: [workspace],
          sql,
          json: [],
          review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
        }),
        password,
      )
      await writeFile(path.join(root, "bundle.json"), bundle)
      await writeFile(path.join(root, "session.json"), JSON.stringify({ id: value.id, path: session.path }))
    } finally {
      db.close()
    }
  } else {
    const saved: unknown = JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))
    assert.ok(saved && typeof saved === "object" && "id" in saved && typeof saved.id === "string")
    const response = await app.request(`/session/${saved.id}`, { headers })
    assert.equal(response.status, 200, await response.clone().text())
    const value: unknown = await response.json()
    assert.ok(value && typeof value === "object" && "directory" in value && "path" in value)
    assert.equal(typeof value.directory, "string")
    assert.equal(path.resolve(String(value.directory)), path.resolve(workspace))
    const relative = globalPath(workspace)
    assert.equal(value.path, relative)
    const listed: unknown = await (
      await app.request(`/session?path=${encodeURIComponent(relative)}`, { headers })
    ).json()
    assert.ok(Array.isArray(listed) && listed.some((item) => typeof item === "object" && item?.id === saved.id))
    const file = process.env.RAYA_DB
    assert.ok(file)
    const db = new Database(file, { readonly: true })
    try {
      for (const table of ["session_input", "message", "part", "raya_routine_occurrence"])
        assert.equal(db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0)
    } finally {
      db.close()
    }
    assert.equal(
      JSON.parse(await readFile(path.join(path.dirname(file), "storage/raya/restore-hold.json"), "utf8")).state,
      "held",
    )
  }
}
console.log(`GLOBAL_SESSION_${mode}_PASS`)
await finish([
  async () => {
    if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
  },
])
