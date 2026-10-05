import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { acquireProfileRoot, registerProfileFile } from "@opencode-ai/core/kilocode/profile-maintenance"
import { memories, scaffold } from "../../src/kilocode/migration/profile-memory"

test("actual retired namespace and session admissions preserve portable memory content", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-coordination-")))
  const workspace = path.join(dir, "workspace")
  await mkdir(workspace)
  const id = MemoryPaths.declared(workspace)
  const container = path.join(dir, "memory")
  const root = path.join(container, id.folder)
  await MemoryFiles.scaffold(root, id)
  await MemoryFiles.writeSession(root, {
    sessionID: "actual-coordination",
    summary: "Retain café 日本語",
    max: 10000,
    time: 1000,
  })
  const before = await memories(container)
  const files = MemoryPaths.files(root)
  const names = await readdir(files.sessions)
  const target = names.find((name) => name.endsWith(".md"))
  assert(target)
  const leases = await Promise.all(
    [root, path.join(files.sessions, target)].map((file) => acquireProfileRoot({ kind: "json", path: file })),
  )
  try {
    await assert.rejects(memories(container), /operations remain/)
  } finally {
    for (const lease of leases) await lease.release()
  }
  expect(await memories(container)).toEqual(before)
  const metadata = path.join(files.sessions, ".raya-profile-locks")
  await writeFile(path.join(metadata, "unknown.txt"), "must refuse")
  await assert.rejects(memories(container), /active or unclassified/)
  await rm(path.join(metadata, "unknown.txt"))
  const marker = (await readdir(metadata)).find((name) => name.endsWith(".writers"))!
  await writeFile(path.join(metadata, marker, "foreign.json"), "{}")
  await assert.rejects(memories(container), /operations remain/)
  await rm(path.join(metadata, marker, "foreign.json"))
  const lifetime = registerProfileFile({ kind: "json", path: path.join(files.sessions, target) })
  const normalized = process.platform === "win32" ? lifetime.path.toLowerCase() : lifetime.path
  const owners = createHash("sha1").update(`raya.profile.json:${normalized}`).digest("hex") + ".owners"
  const owner = path.join(metadata, owners, (await readdir(path.join(metadata, owners)))[0])
  const bytes = await readFile(owner)
  const changed = JSON.parse(bytes.toString())
  changed.root = path.join(dir, "foreign", "session.md")
  await writeFile(owner, JSON.stringify(changed))
  try {
    await assert.rejects(memories(container), /owner binding differs/)
  } finally {
    await writeFile(owner, bytes)
    lifetime.release()
  }
  const gate = path.join(metadata, "0".repeat(40) + ".lock")
  await mkdir(gate)
  await assert.rejects(memories(container), /active or unclassified/)
})

test("purged control residue is inert while missing initialized content still refuses", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-residue-")))
  const container = path.join(dir, "memory")
  const root = path.join(container, "retained-control-scaffold")
  await mkdir(root, { recursive: true })
  const lease = await acquireProfileRoot({ kind: "json", path: path.join(root, "state.json") })
  await lease.release()
  expect(await memories(container)).toEqual([])
  await writeFile(path.join(root, "state.json"), "{}")
  await assert.rejects(memories(container))
  await rm(path.join(root, "state.json"))
  await mkdir(path.join(container, "ordinary-empty-root"))
  await assert.rejects(memories(container))
})

test("queue scaffolds require typed retired coordination and refuse live owners and gates", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-memory-queue-scaffold-")))
  const root = path.join(dir, ".lock")
  await mkdir(root)
  const lease = await acquireProfileRoot({ kind: "json", path: path.join(root, "owner") })
  await assert.rejects(scaffold(root), /operations remain/)
  await lease.release()
  await scaffold(root)
  await writeFile(path.join(root, "owner"), "live-or-uncertain")
  await assert.rejects(scaffold(root), /active or unclassified/)
  await rm(path.join(root, "owner"))
  const metadata = path.join(root, ".raya-profile-locks")
  const gate = path.join(metadata, "0".repeat(40) + ".lock")
  await mkdir(gate)
  await assert.rejects(scaffold(root), /active or unclassified/)
  await rmdir(gate)
  const references = path.join(metadata, "covered.references")
  await mkdir(references, { recursive: true })
  await scaffold(root)
  await writeFile(path.join(references, "foreign.json"), "preserve")
  await assert.rejects(scaffold(root), /operations remain/)
  expect(await readFile(path.join(references, "foreign.json"), "utf8")).toBe("preserve")
  await rm(path.join(references, "foreign.json"))
  await rmdir(references)
  await writeFile(references, "unsupported regular file")
  await assert.rejects(scaffold(root), /Unverified memory covered references/)
  await rm(references)
  await writeFile(path.join(metadata, "unknown.txt"), "foreign")
  await assert.rejects(scaffold(root), /active or unclassified/)
})
