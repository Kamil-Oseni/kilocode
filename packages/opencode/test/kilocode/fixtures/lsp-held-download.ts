import path from "node:path"
import { pathToFileURL } from "node:url"

const file = process.env.RAYA_LSP_FILE!
await Bun.write(process.env.RAYA_LSP_PID!, String(process.pid))
const response = await fetch(process.env.RAYA_LSP_URL!)
await Bun.write(file, await response.text())
await import(pathToFileURL(path.resolve(file)).href)
