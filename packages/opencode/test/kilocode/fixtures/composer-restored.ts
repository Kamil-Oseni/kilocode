import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import type z from "zod"
import { DraftLegacy, DraftImported } from "../../../src/kilocode/session/composer-codec"
import { composers, remapComposers } from "../../../src/kilocode/migration/profile-composers"

export async function verifyComposers(
  root: string,
  original: z.output<typeof composers>,
  mappings: Readonly<Record<string, string>>,
) {
  const document = DraftLegacy.checked(
    JSON.parse(await readFile(path.join(root, "storage/raya/composer-drafts.json"), "utf8")),
  )
  assert.deepEqual(document, JSON.parse(JSON.stringify(remapComposers(original, new Map(Object.entries(mappings))))))
  const marker = DraftImported.parse(
    JSON.parse(await readFile(path.join(root, "storage/raya/composer-drafts-initialized.json"), "utf8")),
  )
  assert.equal(marker.pendingProject, "destination")
  const database = new Database(path.join(root, "raya.db"), { readonly: true })
  try {
    for (const table of ["raya_composer_control", "raya_composer_draft", "session_input"])
      assert.equal(database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0)
  } finally {
    database.close()
  }
  assert.equal(JSON.parse(await readFile(path.join(root, "storage/raya/restore-hold.json"), "utf8")).state, "held")
}
