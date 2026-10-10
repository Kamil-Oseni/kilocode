import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { select } from "../../../src/kilocode/source-offline-selection"

const [account, executable] = process.argv.slice(2)
if (!account || !executable) throw new Error("Cold selection fixture arguments missing")
const digest = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex")
const selection = await select({
  account,
  env: { LOCALAPPDATA: path.join(account, "AppData", "Local") },
  helper: { executable, digest },
})
assert.equal(selection.directory, path.join(account, "AppData", ".raya-offline-recovery"))
await assert.rejects(lstat(selection.directory), { code: "ENOENT" })
assert.equal(selection.receipts.length, 1)
assert.equal(selection.receipts[0].recovered, true)
console.log(JSON.stringify({ recovered: true, stableAbsent: true, receipts: selection.receipts.length }))
