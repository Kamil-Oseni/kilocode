import assert from "node:assert/strict"
import { lstat, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { unseal } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"
const [file, root] = process.argv.slice(2)
const secret = JSON.parse(await Bun.stdin.text())
const text = await readFile(file, "utf8")
const value = await unseal(text, secret.password)
assert(value.selfHeal?.records.length)
const mappings: Record<string, string> = {}
const primaries: string[] = []
for (const [index, workspace] of value.workspaces.entries()) {
  const tree = value.artifacts?.worktrees.find((tree) => tree.workspace === workspace)
  mappings[workspace] = tree
    ? path.join(root, "profile", "data", "kilo", "worktree", tree.project, tree.name)
    : path.join(root, "mapped", String(index))
  if (!tree) await mkdir(mappings[workspace], { recursive: true })
  if (value.artifacts?.repositories.some((repo) => repo.workspace === workspace)) primaries.push(workspace)
}
const result = await restore(text, secret.password, path.join(root, "profile"), mappings, { primaries })
assert.deepEqual(JSON.parse(await readFile(path.join(result.path, "restore-self-heal.json"), "utf8")), value.selfHeal)
for (const row of value.selfHeal.checkouts ?? []) {
  const id = createHash("sha256")
    .update(row.original + "\0" + row.digest)
    .digest("hex")
  for (const file of row.files)
    assert.deepEqual(
      await readFile(path.join(result.path, "restore-self-heal-checkouts", id, "tree", ...file.path.split("/"))),
      Buffer.from(file.data, "base64"),
    )
}
const db = new Database(path.join(result.path, "raya.db"), { readonly: true })
assert.deepEqual(db.query("SELECT count(*) AS n FROM session_input").get(), { n: 0 })
assert.deepEqual(db.query("SELECT count(*) AS n FROM raya_routine_occurrence").get(), { n: 0 })
db.close()
await assert.rejects(lstat(path.join(result.path, "storage", "raya", "self-heal", "item")), { code: "ENOENT" })
console.log("SOURCE_SELF_HEAL_INACTIVE_RESTORE_OK")
await finish([])
