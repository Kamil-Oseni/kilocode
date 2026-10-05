import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { quarantineSidecar } from "../../../src/kilocode/migration/profile-memory-quarantine-history"
import { validateMemory } from "../../../src/kilocode/migration/profile-memory-correspondence"
import type { payload } from "../../../src/kilocode/migration/profile-bundle"
import type { memory } from "../../../src/kilocode/migration/profile-memory"
import type z from "zod"

type Bundle = z.output<typeof payload>
type Memory = z.output<typeof memory>
type Claim = NonNullable<Bundle["disposition"]>["files"][number]
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

export async function hosted(root: string, workspace: string, env: Record<string, string>, evidence: string) {
  const report = path.join(evidence, "hosted-memory-seed.private.json")
  const helper = process.env.RAYA_TEST_DIRECTORY_HELPER
  assert(helper && path.isAbsolute(helper), "Hosted seed requires an explicit accepted helper")
  const digest = sha(await readFile(helper))
  if (process.env.RAYA_TEST_DIRECTORY_HELPER_SHA) assert.equal(digest, process.env.RAYA_TEST_DIRECTORY_HELPER_SHA)
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--preload",
      path.resolve(import.meta.dir, "../../../node_modules/@opentui/solid/scripts/preload.js"),
      path.join(import.meta.dir, "source-memory-hosted-seed.ts"),
      root,
      workspace,
      report,
      helper,
    ],
    { cwd: path.resolve(import.meta.dir, "../../.."), env, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  let forced = false
  const timer = setTimeout(() => {
    forced = true
    child.kill()
  }, 30000)
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  await writeFile(path.join(evidence, "hosted-memory-seed.stdout.log"), output)
  await writeFile(path.join(evidence, "hosted-memory-seed.stderr.log"), error)
  assert.equal(code, 0, error)
  assert.equal(forced, false)
  const info = await lstat(report, { bigint: true })
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size <= 4n * 1048576n)
  const raw = await readFile(report)
  const value = JSON.parse(raw.toString())
  assert.equal(value.owner.pid, child.pid)
  assert(/^\d+$/.test(value.owner.birth))
  const inspected = await NativeProcess.inspect(child.pid, helper)
  assert(inspected && typeof inspected === "object" && "status" in inspected && "birth" in inspected)
  assert(inspected.status === "gone" || (inspected.status === "owned" && inspected.birth !== value.owner.birth))
  assert.equal(value.hosted, true)
  assert.equal(value.shutdownJoined, true)
  assert.equal(value.profileClosed, true)
  assert.equal(value.after.terminal, true)
  assert.equal(value.after.failures, 0)
  assert.deepEqual(value.after.roots, [])
  assert.equal(
    value.writers.active.find((entry: { id: string; count: number }) => entry.id === "profile.data.memory")?.count ?? 0,
    0,
  )
  assert(value.markers.length > 0)
  for (const marker of value.markers) assert.equal(await Bun.file(marker.path).exists(), false)
  for (const file of value.files) {
    const raw = await readFile(file.path)
    const info = await lstat(file.path, { bigint: true })
    assert.equal(raw.length, file.bytes)
    assert.equal(sha(raw), file.digest)
    assert.equal(String(info.dev), file.dev)
    assert.equal(String(info.ino), file.ino)
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
  }
  for (const entry of value.metadata) {
    const info = await lstat(entry.path, { bigint: true })
    assert(info.isDirectory() && !info.isSymbolicLink())
    assert.equal(String(info.dev), entry.dev)
    assert.equal(String(info.ino), entry.ino)
    assert.deepEqual(await readdir(entry.path), [])
  }
  const backups: Awaited<ReturnType<typeof seed>> = value.backups
  for (const item of backups) {
    const raw = await readFile(item.source)
    assert.equal(raw.length, item.bytes)
    assert.equal(sha(raw), item.digest)
    const info = await lstat(item.source, { bigint: true })
    assert.equal(String(info.dev), item.dev)
    assert.equal(String(info.ino), item.ino)
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
  }
  await writeFile(
    path.join(evidence, "hosted-memory-seed-receipt.json"),
    JSON.stringify({
      naturalExitCode: code,
      forced: false,
      root,
      workspace,
      privateReceipt: { path: report, bytes: raw.length, digest: sha(raw) },
      fixture: {
        path: path.join(import.meta.dir, "source-memory-hosted-seed.ts"),
        digest: sha(await readFile(path.join(import.meta.dir, "source-memory-hosted-seed.ts"))),
      },
      helper: { path: helper, digest },
      originalBirthAbsent: true,
      owner: value.owner,
      shutdownJoined: true,
      profileClosed: true,
      hosted: true,
      markers: value.markers,
      files: value.files,
      metadata: value.metadata,
      writers: value.writers,
      after: value.after,
      backups: backups.map(({ text: _, ...entry }) => entry),
    }),
  )
  return backups
}

export async function seed(root: string) {
  const values = []
  for (const text of [
    " ".repeat(600_000) + "{",
    JSON.stringify({ version: 2, enabled: true, padding: "x".repeat(600_000) }),
  ]) {
    const before = new Set(await readdir(root))
    const prior = [...before]
      .filter((name) => /^state\.json\.bad-[0-9]+$/.test(name))
      .map((name) => Number(name.slice(15)))
    while (Date.now() <= Math.max(0, ...prior)) await Bun.sleep(1)
    await writeFile(MemoryPaths.files(root).state, text)
    assert.equal((await MemoryFiles.readState(root)).enabled, false)
    const names = (await readdir(root)).filter((name) => /^state\.json\.bad-[0-9]+$/.test(name) && !before.has(name))
    assert.equal(names.length, 1)
    const source = path.join(root, names[0])
    const info = await lstat(source, { bigint: true })
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
    assert.equal(await readFile(source, "utf8"), text)
    values.push({
      source,
      name: names[0],
      text,
      bytes: Buffer.byteLength(text),
      digest: sha(text),
      dev: String(info.dev),
      ino: String(info.ino),
    })
  }
  assert(values.every((value) => value.bytes <= 1048576))
  assert(values.reduce((sum, value) => sum + value.bytes, 0) > 1048576)
  return values
}

export async function current(bundle: Bundle, expected: Awaited<ReturnType<typeof seed>>) {
  const item = bundle.memory.find((value) => value.quarantine?.some((entry) => entry.source === expected[0].source))
  assert(item?.quarantine && bundle.disposition)
  assert.equal(item.quarantine.length, expected.length)
  for (const value of expected) {
    const entry: NonNullable<Memory["quarantine"]>[number] | undefined = item.quarantine.find(
      (entry) => entry.source === value.source,
    )
    assert(entry)
    assert.deepEqual(
      { name: entry.name, text: entry.text, bytes: entry.bytes, digest: entry.digest },
      { name: value.name, text: value.text, bytes: value.bytes, digest: value.digest },
    )
    const claim: Claim | undefined = bundle.disposition.files.find((entry) => entry.path === value.source)
    assert(claim?.disposition.kind === "memory-semantic" && claim.disposition.selector.kind === "quarantine")
    assert.equal(claim.disposition.selector.name, value.name)
    assert.equal(claim.disposition.rawBytesPreserved, true)
    assert.deepEqual(
      { dev: claim.dev, ino: claim.ino, bytes: claim.bytes, digest: claim.digest },
      { dev: value.dev, ino: value.ino, bytes: value.bytes, digest: value.digest },
    )
    validateMemory(claim.disposition, bundle)
  }
  assert.equal(JSON.parse(item.state).enabled, false)
  return item.quarantine.map(({ text: _, ...entry }) => entry)
}

export async function restored(data: string, expected: readonly Memory[]) {
  const values = expected.filter((item) => item.quarantine?.length)
  assert(values.length > 0)
  const dirs = await readdir(path.join(data, "memory"), { withFileTypes: true })
  const results = []
  for (const item of values) {
    const matches = []
    for (const dir of dirs.filter((dir) => dir.isDirectory())) {
      const root = path.join(data, "memory", dir.name)
      const file = path.join(root, "restore-quarantine.json")
      if (!(await Bun.file(file).exists())) continue
      const raw = await readFile(file)
      const sidecar = quarantineSidecar.parse(JSON.parse(raw.toString()))
      if (JSON.stringify(sidecar.entries) !== JSON.stringify(item.quarantine)) continue
      assert.deepEqual(sidecar.prior, item.quarantineLineage)
      assert.equal(
        (await readdir(root)).some((name) => name.startsWith("state.json.bad-")),
        false,
      )
      assert.equal(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).enabled, false)
      const info = await lstat(file, { bigint: true })
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
      assert(raw.length > 1048576 && raw.length <= 32 * 1048576)
      matches.push({ file, digest: sha(raw), bytes: raw.length, dev: String(info.dev), ino: String(info.ino) })
    }
    assert.equal(matches.length, 1)
    results.push(matches[0])
  }
  assert.equal(JSON.parse(await readFile(path.join(data, "storage/raya/restore-hold.json"), "utf8")).state, "held")
  return results
}

export function historical(bundle: Bundle, expected: readonly Memory[], prior: Awaited<ReturnType<typeof restored>>) {
  assert(bundle.disposition)
  for (const item of expected.filter((item) => item.quarantine?.length)) {
    const value = bundle.memory.find((value) => JSON.stringify(value.sources) === JSON.stringify(item.sources))
    assert(value?.quarantine && value.quarantineLineage)
    assert.deepEqual(value.quarantine, item.quarantine)
    for (const record of prior) {
      const lineage: NonNullable<Memory["quarantineLineage"]>["records"][number] | undefined =
        value.quarantineLineage.records.find((entry) => entry.source === record.file)
      assert(lineage && lineage.digest === record.digest && lineage.bytes === record.bytes)
      assert(lineage.entries.every((entry) => !("text" in entry)))
      const claim: Claim | undefined = bundle.disposition.files.find((entry) => entry.path === record.file)
      assert(claim?.disposition.kind === "memory-semantic" && claim.disposition.selector.kind === "quarantine-prior")
      assert.equal(claim.disposition.rawBytesPreserved, false)
      assert.deepEqual(
        { dev: claim.dev, ino: claim.ino, bytes: claim.bytes, digest: claim.digest },
        { dev: record.dev, ino: record.ino, bytes: record.bytes, digest: record.digest },
      )
      validateMemory(claim.disposition, bundle)
    }
    assert.equal(
      bundle.disposition.files.some(
        (entry) => entry.disposition.kind === "memory-semantic" && entry.disposition.selector.kind === "quarantine",
      ),
      false,
    )
  }
}
