import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite" // kilocode_change

export function init(path: string) {
  const sqlite = profileSqlite(path, (file) => new DatabaseSync(file)) // kilocode_change
  const db = drizzle({ client: sqlite })
  return db
}
