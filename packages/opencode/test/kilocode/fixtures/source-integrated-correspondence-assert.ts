import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type z from "zod"
import type { payload } from "../../../src/kilocode/migration/profile-bundle"
import { validateRestoredSources } from "../../../src/kilocode/migration/profile-restored-source-correspondence"
import { validateRestoredComponents } from "../../../src/kilocode/migration/profile-restored-components-correspondence"
import { validateTui } from "../../../src/kilocode/migration/profile-tui-correspondence"
import { validateHold } from "../../../src/kilocode/migration/profile-restore-hold-correspondence"
import { validateSQL } from "../../../src/kilocode/migration/profile-sql-correspondence"
import { allocatorLedger } from "../../../src/kilocode/migration/profile-sql-metadata"

type Payload = z.output<typeof payload>
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

export async function assertIntegratedSource(bundle: Payload, prior?: Payload, data?: string) {
  assert(bundle.disposition)
  const files = bundle.disposition.files
  const sql = files.filter((file) => file.disposition.kind === "sqlite-semantic")
  assert(sql.length > 0)
  for (const file of sql) {
    if (file.disposition.kind !== "sqlite-semantic") continue
    validateSQL(file.disposition, bundle)
    assert.equal(file.disposition.complete, true)
  }
  const tui = files.filter((file) => file.disposition.kind === "tui-json")
  assert(tui.length > 0)
  for (const file of tui) {
    if (file.disposition.kind !== "tui-json") continue
    validateTui(file.disposition, bundle)
    assert.equal(file.digest, file.disposition.digest)
    assert.equal(file.bytes, Buffer.byteLength(file.disposition.text))
  }
  assert(bundle.tui?.scopes.some((scope) => scope.values.terminal_title_enabled === false))
  const git = files.filter((file) => file.disposition.kind === "restored-git")
  const sidecars = files.filter((file) => file.disposition.kind === "restored-component")
  const sources = files.filter((file) => file.disposition.kind === "restored-source")
  const holds = files.filter((file) => file.disposition.kind === "restore-hold")
  if (prior && data) {
    assert(bundle.restoredSources)
    validateRestoredSources(bundle.restoredSources, bundle)
    assert.equal(sources.length, 1)
    const source = sources[0].disposition
    if (source.kind !== "restored-source") throw new Error("Integrated Source lacks restored source binding")
    const raw = await readFile(path.join(data, "restore-source.json"))
    assert.equal(source.digest, hash(raw))
    assert.equal(source.bytes, raw.length)
    assert(bundle.restoredSources.some((entry) => entry.archive === prior.id))
    assert(bundle.restoredComponents)
    validateRestoredComponents(bundle.restoredComponents, bundle)
    const routes = {
      config: "restore-config.json",
      disposition: "restore-disposition.json",
      secondary: "restore-secondary.json",
      voice: "restore-voice-reconciliation.json",
      operational: "restore-operational.json",
      host: "restore-host.json",
      tui: "restore-tui.json",
      preferences: "restore-preferences.json",
      notes: "restore-notes.json",
      outputs: "restore-outputs.json",
      selfHeal: "restore-self-heal.json",
      sqlMetadata: "restore-sql-metadata.json",
      review: "restore-review.json",
      stores: "restore-stores.json",
    } as const
    for (const selector of [
      "config",
      "disposition",
      "secondary",
      "voice",
      "operational",
      "host",
      "tui",
      "preferences",
      "notes",
      "outputs",
      "selfHeal",
      "sqlMetadata",
      "review",
      "stores",
    ] as const) {
      if (
        selector !== "review" &&
        (selector === "sqlMetadata" ? allocatorLedger(prior.disposition) : prior[selector]) === undefined
      )
        continue
      const matches = sidecars.filter(
        (file) => file.disposition.kind === "restored-component" && file.disposition.selector === selector,
      )
      assert.equal(matches.length, 1)
      const component = matches[0].disposition
      if (component.kind !== "restored-component") throw new Error("Integrated Source lacks restored component binding")
      const text: Buffer = await readFile(path.join(data, routes[selector]))
      assert.equal(component.digest, hash(text))
      assert.equal(component.bytes, text.length)
    }
    assert(git.length > 0)
    assert(holds.length > 0)
    for (const file of holds) {
      if (file.disposition.kind !== "restore-hold") continue
      validateHold(file.disposition, bundle)
      const raw: Buffer = await readFile(path.join(data, "storage/raya/restore-hold.json"))
      assert.equal(file.digest, hash(raw))
      assert.equal(file.bytes, raw.length)
    }
  }
  return {
    files: files.length,
    unknown: files.filter((file) => file.disposition.kind === "unclassified").length,
    sql: sql.length,
    sqlComplete: true,
    tui: tui.length,
    restoredGit: git.length,
    restoredSources: sources.length,
    sidecars: sidecars.length,
    sidecarSelectors: [
      ...new Set(
        sidecars.flatMap((file) => (file.disposition.kind === "restored-component" ? [file.disposition.selector] : [])),
      ),
    ].sort(),
    hold: holds.length,
    portableCaptureAuthorized: false,
  }
}
