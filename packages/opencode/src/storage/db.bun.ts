import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite" // kilocode_change

export function init(path: string) {
  const sqlite = profileSqlite(path, (file) => new Database(file, { create: true })) // kilocode_change
  const db = drizzle({ client: sqlite })
  return db
}
