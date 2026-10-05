import path from "node:path"
import { Database } from "bun:sqlite"
import { profileSqlite, closeProfileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"
const root = process.argv[2]
const db = profileSqlite(path.join(root, "source.db"), (file) => new Database(file))
await Bun.write(path.join(root, "foreign-ready.json"), JSON.stringify({ pid: process.pid }))
while (!(await Bun.file(path.join(root, "release-foreign")).exists())) await Bun.sleep(25)
await closeProfileSqlite(db)
