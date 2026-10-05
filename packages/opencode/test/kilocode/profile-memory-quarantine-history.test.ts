import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import {
  quarantineLineage,
  quarantineSidecar,
  readQuarantineSidecar,
  renderQuarantine,
} from "../../src/kilocode/migration/profile-memory-quarantine-history"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-quarantine-history-")))
  const workspace = path.join(base, "workspace")
  await mkdir(workspace)
  const root = path.join(base, "memory", MemoryPaths.declared(workspace).folder)
  await mkdir(root, { recursive: true })
  const file = path.join(root, "restore-quarantine.json")
  const text = "broken café 日本語 😀\n"
  const entry = {
    source: path.join(root, "state.json.bad-1000"),
    workspace,
    name: "state.json.bad-1000",
    text,
    bytes: Buffer.byteLength(text),
    digest: sha(text),
    activation: "inert" as const,
  }
  return { base, workspace, root, file, entry }
}
test("quarantine sidecar retains flat original bodies across actual two-hop filesystem reads", async () => {
  const item = await fixture()
  expect(await readQuarantineSidecar(item.file, { workspace: item.workspace })).toBeUndefined()
  const initial = renderQuarantine([item.entry])
  const text = JSON.stringify(initial)
  await writeFile(item.file, text)
  const first = await readQuarantineSidecar(item.file, { source: item.file, workspace: item.workspace })
  expect(first?.entries).toEqual([item.entry])
  expect(first?.lineage?.records[0].digest).toBe(sha(text))
  expect(first?.lineage?.records[0].bytes).toBe(Buffer.byteLength(text))
  expect(await readQuarantineSidecar(item.file, { workspace: item.workspace })).toEqual({
    entries: [item.entry],
    lineage: undefined,
  })
  const target = path.join(item.base, "next", MemoryPaths.declared(item.workspace).folder)
  await mkdir(target, { recursive: true })
  const next = path.join(target, "restore-quarantine.json")
  await writeFile(next, JSON.stringify(renderQuarantine(first!.entries, first!.lineage)))
  const second = await readQuarantineSidecar(next, { source: next, workspace: item.workspace })
  expect(second?.entries).toEqual([item.entry])
  expect(second?.lineage?.records).toHaveLength(2)
  expect(second?.lineage?.records[1].prior).toEqual([{ source: item.file, digest: sha(text) }])
  expect(JSON.stringify(second?.lineage)).not.toContain(item.entry.text)
  expect(renderQuarantine(second!.entries, second!.lineage).entries).toHaveLength(1)
})
test("quarantine sidecar rejects forged projections, cycles, case conflicts and conflicting duplicates", async () => {
  const item = await fixture()
  await writeFile(item.file, JSON.stringify(renderQuarantine([item.entry])))
  const first = await readQuarantineSidecar(item.file, { source: item.file, workspace: item.workspace })
  const lineage = first!.lineage!
  const changed = structuredClone(lineage)
  changed.records[0].entries[0].bytes++
  expect(() => renderQuarantine(first!.entries, changed)).toThrow("projection")
  const coordinated = structuredClone(first!)
  coordinated.entries[0].text = "coordinated replacement"
  coordinated.entries[0].bytes = Buffer.byteLength(coordinated.entries[0].text)
  coordinated.entries[0].digest = sha(coordinated.entries[0].text)
  const { text: _, ...reference } = coordinated.entries[0]
  coordinated.lineage!.records[0].entries[0] = reference
  expect(() => renderQuarantine(coordinated.entries, coordinated.lineage)).toThrow("reconstruction")
  const cyclic = structuredClone(lineage)
  cyclic.records[0].prior.push({ source: cyclic.records[0].source, digest: cyclic.records[0].digest })
  expect(quarantineLineage.safeParse(cyclic).success).toBe(false)
  expect(quarantineLineage.safeParse({ ...lineage, records: [...lineage.records, lineage.records[0]] }).success).toBe(
    false,
  )
  expect(
    renderQuarantine(first!.entries, { ...lineage, records: [...lineage.records, lineage.records[0]] }).prior?.records,
  ).toHaveLength(1)
  const duplicate = structuredClone(lineage.records[0])
  duplicate.bytes++
  expect(() => renderQuarantine(first!.entries, { ...lineage, records: [...lineage.records, duplicate] })).toThrow(
    "Conflicting",
  )
  const foreign = structuredClone(lineage)
  foreign.records[0].source = path.join(item.root, "wrong.json")
  expect(quarantineLineage.safeParse(foreign).success).toBe(false)
  const casing = structuredClone(lineage.records[0])
  casing.source = path.join(path.dirname(item.root).toUpperCase(), path.basename(item.root), "restore-quarantine.json")
  casing.digest = "f".repeat(64)
  expect(quarantineLineage.safeParse({ ...lineage, records: [...lineage.records, casing] }).success).toBe(false)
  const unknown = structuredClone(lineage)
  unknown.records[0].prior.push({ source: item.file, digest: "e".repeat(64) })
  expect(quarantineLineage.safeParse(unknown).success).toBe(false)
  expect(quarantineSidecar.safeParse({ ...renderQuarantine([item.entry]), extra: true }).success).toBe(false)
})

test("non-writer formatting refuses while canonical explicit empty prior and BOM remain byte-bound", async () => {
  const item = await fixture()
  const value = renderQuarantine([item.entry], { version: 1, activation: "inert", records: [] })
  await writeFile(item.file, JSON.stringify(value, null, 2))
  await assert.rejects(readQuarantineSidecar(item.file, { source: item.file, workspace: item.workspace }), /canonical/)
  await writeFile(item.file, "\ufeff" + JSON.stringify(value))
  const accepted = await readQuarantineSidecar(item.file, { source: item.file, workspace: item.workspace })
  expect(accepted!.lineage!.records[0].encoding).toEqual({ bom: true, prior: true })
  const changed = structuredClone(accepted!.lineage!)
  changed.records[0].encoding.bom = false
  expect(() => renderQuarantine(accepted!.entries, changed)).toThrow("reconstruction")
})
test("quarantine sidecar rejects actual hardlinks, invalid UTF8 and invalid source binding", async () => {
  const item = await fixture()
  await writeFile(item.file, JSON.stringify(renderQuarantine([item.entry])))
  await link(item.file, path.join(item.root, "alias"))
  await assert.rejects(readQuarantineSidecar(item.file, { workspace: item.workspace }), /unique/)
  const invalid = await fixture()
  await writeFile(invalid.file, Buffer.from([0xff]))
  await assert.rejects(readQuarantineSidecar(invalid.file, { workspace: invalid.workspace }))
  const source = await fixture()
  await writeFile(source.file, JSON.stringify(renderQuarantine([source.entry])))
  await assert.rejects(
    readQuarantineSidecar(source.file, {
      source: path.join(source.base, "restore-quarantine.json"),
      workspace: source.workspace,
    }),
    /selector/,
  )
})
test("quarantine sidecar preserves the complete four MiB original budget outside ordinary evidence limits", async () => {
  const item = await fixture()
  const text = "\u0001".repeat(1048576)
  const entries = Array.from({ length: 4 }, (_, index) => ({
    ...item.entry,
    source: path.join(item.root, `state.json.bad-${index}`),
    name: `state.json.bad-${index}`,
    text,
    bytes: Buffer.byteLength(text),
    digest: sha(text),
  }))
  const rendered = renderQuarantine(entries)
  const raw = JSON.stringify(rendered)
  expect(Buffer.byteLength(raw)).toBeGreaterThan(4 * 1048576)
  expect(Buffer.byteLength(raw)).toBeLessThan(32 * 1048576)
  await writeFile(item.file, "\ufeff" + raw)
  const read = await readQuarantineSidecar(item.file, { source: item.file, workspace: item.workspace })
  expect(read?.entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(4 * 1048576)
  expect(read?.lineage?.records[0].bytes).toBe(Buffer.byteLength("\ufeff" + raw))
  expect(read?.lineage?.records[0].digest).toBe(sha("\ufeff" + raw))
  expect(() =>
    renderQuarantine([
      ...entries,
      { ...item.entry, source: path.join(item.root, "state.json.bad-9"), name: "state.json.bad-9" },
    ]),
  ).toThrow()
})
