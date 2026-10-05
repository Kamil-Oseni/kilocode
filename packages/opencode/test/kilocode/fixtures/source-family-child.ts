import path from "node:path"
import { Database } from "bun:sqlite"
const root = process.argv[2]
const mode = process.argv[3]
const db = new Database(path.join(root, "descendant.db"))
db.run("CREATE TABLE durable(value TEXT)")
db.run("INSERT INTO durable VALUES ('accepted')")
await Bun.write(path.join(root, "child-ready.json"), JSON.stringify({ pid: process.pid }))
while (!(await Bun.file(path.join(root, "release-child")).exists())) await Bun.sleep(25)
db.run("INSERT INTO durable VALUES ('child-final')")
db.close()
process.exitCode = mode === "failed-child" ? 1 : 0
