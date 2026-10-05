import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, lstat, mkdir, readdir, rename, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { tmpdir } from "../fixture/fixture"
import { readQuarantine } from "../../src/kilocode/migration/profile-memory-quarantine"
import {
  quarantine,
  quarantineEntry,
  quarantineName,
  quarantineReference,
} from "../../src/kilocode/migration/profile-memory-quarantine-schema"

async function namespace(base: string) {
  const workspace = path.join(base, "workspace")
  await mkdir(workspace)
  const id = MemoryPaths.declared(workspace)
  const source = path.join(base, "memory", id.folder)
  await MemoryFiles.scaffold(source, id)
  return { source, workspace }
}

test("actual malformed and unsupported state recovery backups preserve their exact original inert bytes", async () => {
  for (const seed of ["{", JSON.stringify({ version: 2, enabled: true })]) {
    await using tmp = await tmpdir()
    const input = await namespace(tmp.path)
    await writeFile(MemoryPaths.files(input.source).state, seed)
    const state = await MemoryFiles.readState(input.source)
    expect(state.enabled).toBe(false)
    const entries = await readQuarantine(input.source, input)
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe(seed)
    expect(entries[0].bytes).toBe(Buffer.byteLength(seed))
    expect(entries[0].digest).toBe(createHash("sha256").update(seed).digest("hex"))
    expect(entries[0].activation).toBe("inert")
    const { text, ...reference } = entries[0]
    expect(quarantineReference.parse(reference)).toEqual(reference)
    expect(text).toBe(seed)
    expect((await lstat(entries[0].source)).isFile()).toBe(true)
  }
})

test("BOM, CRLF, Unicode and empty original backup bytes round trip exactly without JSON activation", async () => {
  await using tmp = await tmpdir()
  const input = await namespace(tmp.path)
  const bodies = [Buffer.from("\uFEFF{\r\n日本語 😀\r\n"), Buffer.from(""), Buffer.from("\u0000\t")]
  for (const [index, body] of bodies.entries())
    await writeFile(path.join(input.source, `state.json.bad-${index}`), body)
  const entries = await readQuarantine(input.source, input)
  expect(entries).toHaveLength(bodies.length)
  for (const [index, value] of entries.entries()) {
    expect(Buffer.from(value.text, "utf8")).toEqual(bodies[index])
    expect(value.digest).toBe(createHash("sha256").update(bodies[index]).digest("hex"))
  }
  expect(entries[0].text.charCodeAt(0)).toBe(0xfeff)
  expect(quarantine.parse(JSON.parse(JSON.stringify(entries)))).toEqual(entries)
})

test("invalid UTF8 and credential-shaped original bytes refuse without changing the original backup", async () => {
  for (const body of [
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xef, 0xbb]),
    Buffer.from('{"password":"synthetic-private-value"}'),
  ]) {
    await using tmp = await tmpdir()
    const input = await namespace(tmp.path)
    const file = path.join(input.source, "state.json.bad-1")
    await writeFile(file, body)
    await assert.rejects(readQuarantine(input.source, input))
    expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(body)
  }
})

test("canonical names and historical identities remain distinct from current-file selection", async () => {
  for (const name of [
    "state.json.bad-01",
    "state.json.bad--1",
    "state.json.bad-1.json",
    "STATE.JSON.BAD-1",
    "state.json.bad-9007199254740992",
    "state.json.bad-1/escape",
  ])
    expect(quarantineName.safeParse(name).success).toBe(false)
  await using tmp = await tmpdir()
  const one = await namespace(tmp.path)
  await writeFile(path.join(one.source, "state.json.bad-1"), "first original")
  const entries = await readQuarantine(one.source, one)
  expect(quarantine.safeParse([...entries, ...entries]).success).toBe(false)
  const other = path.join(tmp.path, "other")
  await mkdir(other)
  const two = await namespace(other)
  await writeFile(path.join(two.source, "state.json.bad-1"), "other original")
  expect(quarantine.parse([...entries, ...(await readQuarantine(two.source, two))])).toHaveLength(2)
  expect(quarantineEntry.safeParse({ ...entries[0], text: "changed" }).success).toBe(false)
  expect(quarantineEntry.safeParse({ ...entries[0], text: "\ud800" }).success).toBe(false)
  expect(quarantineReference.safeParse({ ...entries[0], text: undefined }).success).toBe(false)
  await writeFile(path.join(one.source, "state.json.bad-01"), "noncanonical spelling")
  await assert.rejects(readQuarantine(one.source, one))
})

test("file, count and aggregate byte bounds refuse actual filesystem inventories before accepting bodies", async () => {
  await using tmp = await tmpdir()
  const input = await namespace(tmp.path)
  const file = path.join(input.source, "state.json.bad-0")
  await writeFile(file, "")
  await truncate(file, 1048577)
  await assert.rejects(readQuarantine(input.source, input), /bounded unique regular file/)
  await truncate(file, 1048576)
  for (let index = 1; index < 5; index++) {
    const file = path.join(input.source, `state.json.bad-${index}`)
    await writeFile(file, "")
    await truncate(file, 1048576)
  }
  await assert.rejects(readQuarantine(input.source, input), /inventory exceeds its byte bound/)
  for (const name of await readdir(input.source))
    if (name.startsWith("state.json.bad-")) await truncate(path.join(input.source, name), 0)
  for (let index = 5; index < 65; index++) await writeFile(path.join(input.source, `state.json.bad-${index}`), "")
  await assert.rejects(readQuarantine(input.source, input), /inventory exceeds its bound/)
})

test("actual hardlinks, namespace junction replacement and nonregular backup candidates refuse", async () => {
  await using dir = await tmpdir()
  const candidate = await namespace(dir.path)
  await mkdir(path.join(candidate.source, "state.json.bad-2"))
  await assert.rejects(readQuarantine(candidate.source, candidate), /unique regular file/)
  await using tmp = await tmpdir()
  const input = await namespace(tmp.path)
  const file = path.join(input.source, "state.json.bad-1")
  await writeFile(file, "retained original")
  await link(file, path.join(tmp.path, "outside"))
  await assert.rejects(readQuarantine(input.source, input), /unique regular file/)
  const old = input.source + "-original"
  await rename(input.source, old)
  const foreign = path.join(tmp.path, "foreign")
  await mkdir(foreign)
  await symlink(foreign, input.source, process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(readQuarantine(input.source, input), /canonical regular directory/)
  expect(await Bun.file(path.join(old, "state.json.bad-1")).text()).toBe("retained original")
})

test("the full raw-byte budget survives worst-case JSON escaping and the maximum empty inventory", async () => {
  await using tmp = await tmpdir()
  const input = await namespace(tmp.path)
  const body = Buffer.alloc(1048576, 0)
  for (let index = 0; index < 4; index++) await writeFile(path.join(input.source, `state.json.bad-${index}`), body)
  const entries = await readQuarantine(input.source, input)
  expect(entries.reduce((sum, value) => sum + value.bytes, 0)).toBe(4194304)
  const encoded = JSON.stringify(entries)
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(33554432)
  expect(quarantine.parse(JSON.parse(encoded))).toEqual(entries)
  for (let index = 0; index < 64; index++) await writeFile(path.join(input.source, `state.json.bad-${index}`), "")
  expect(await readQuarantine(input.source, input)).toHaveLength(64)
})
