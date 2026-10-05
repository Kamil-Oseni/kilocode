import { DatabaseSync } from "node:sqlite"
import { run } from "./profile-filename"

await run((file) => new DatabaseSync(file))
