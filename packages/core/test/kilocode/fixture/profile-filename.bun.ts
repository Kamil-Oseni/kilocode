import { Database } from "bun:sqlite"
import { run } from "./profile-filename"

await run((file) => new Database(file, { create: true }))
