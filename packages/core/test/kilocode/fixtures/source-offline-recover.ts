import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { recover } from "../../../src/kilocode/source-offline"
const [control, executable] = process.argv.slice(2)
if (!control || !executable) throw new Error("Recovery arguments missing")
const digest = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex")
console.log(JSON.stringify(await recover(control, { executable, digest })))
