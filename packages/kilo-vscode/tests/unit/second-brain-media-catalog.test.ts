import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, link, readFile, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runtime, validate, sources, dependencies, current as fresh } from "../../src/second-brain/media/catalog"
import { sha } from "../../src/second-brain/control/frames"
import { interpreter } from "../../src/second-brain/managed/catalog"
import { catalogs } from "../../src/second-brain/managed/reuse-catalog"
import { current, supervisors } from "../../src/second-brain/managed/catalog"
import { release } from "../../src/second-brain/control/catalog-capture"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { fixture as owned } from "./fixtures/media-provision"
import { prepare } from "../../src/second-brain/media/provision"
import { space } from "../../src/second-brain/managed/generation"

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-media-catalog-"))
  const dependencies = path.join(dir, "dependencies")
  await mkdir(dependencies)
  const file = path.join(dependencies, "selected.py")
  await writeFile(file, "selected")
  const inventory = path.join(dir, "inventory.json")
  const python = path.join(dir, "python.exe")
  await writeFile(python, "unapproved executable")
  const config = {
    format: "raya.media.runtime.v1",
    python: { path: python, bytes: 21, sha256: interpreter },
    dependencies,
    inventory: { path: inventory, bytes: 1, sha256: "a".repeat(64) },
    model: { path: path.join(dir, "model.json"), bytes: 1, sha256: catalogs["google--embeddinggemma-2.json"] },
  }
  const publish = async (files = [{ path: "selected.py", bytes: 8, sha256: sha("selected") }], root = dependencies) => {
    const raw = JSON.stringify({ format: "raya.media.dependencies.v1", root, files })
    await writeFile(inventory, raw)
    return { ...config, inventory: { path: inventory, bytes: Buffer.byteLength(raw), sha256: sha(raw) } }
  }
  const cleanup = async () => {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()))
    expect(path.basename(dir).startsWith("raya-media-catalog-")).toBe(true)
    await rm(dir, { recursive: true })
  }
  return { dir, dependencies, file, config, publish, cleanup }
}

test("media runtime identity rejects unreviewed interpreter, manifest or extra configuration", async () => {
  const f = await fixture()
  try {
    expect(runtime(f.config).python.sha256).toBe(interpreter)
    expect(() => runtime({ ...f.config, python: { ...f.config.python, sha256: "a".repeat(64) } })).toThrow("Reviewed")
    expect(() => runtime({ ...f.config, model: { ...f.config.model, sha256: "b".repeat(64) } })).toThrow("Reviewed")
    expect(() => runtime({ ...f.config, allow_unpinned: true })).toThrow()
    const cfg = await f.publish()
    await expect(validate(cfg)).rejects.toThrow("runtime metadata changed")
  } finally {
    await f.cleanup()
  }
})

test("complete streamed dependency audit refuses omitted files, changes, links and different roots", async () => {
  const f = await fixture()
  try {
    const cfg = await f.publish()
    await writeFile(path.join(f.dependencies, "ambient.dll"), "unselected")
    await expect(validate(await f.publish())).rejects.toThrow("incomplete")
    await rm(path.join(f.dependencies, "ambient.dll"))
    await writeFile(f.file, "tampered")
    await expect(validate(cfg)).rejects.toThrow("digest differs")
    await writeFile(f.file, "selected")
    await link(f.file, path.join(f.dependencies, "linked.py"))
    const linked = await f.publish([
      { path: "selected.py", bytes: 8, sha256: sha("selected") },
      { path: "linked.py", bytes: 8, sha256: sha("selected") },
    ])
    await expect(validate(linked)).rejects.toThrow("single-link")
    await rm(path.join(f.dependencies, "linked.py"))
    await expect(validate(await f.publish(undefined, f.dir))).rejects.toThrow("different selected root")
    await mkdir(path.join(f.dependencies, "__pycache__"))
    await writeFile(path.join(f.dependencies, "__pycache__", "ambient.pyc"), "unselected")
    await expect(validate(await f.publish())).rejects.toThrow("incomplete")
  } finally {
    await f.cleanup()
  }
})

test("media qualification observes cancellation before and during asynchronous inspection", async () => {
  const f = await fixture()
  try {
    const cfg = await f.publish()
    const before = new AbortController()
    before.abort(new Error("cancelled before media qualification"))
    await expect(validate(cfg, before.signal)).rejects.toThrow("cancelled before")
    await expect(sources(path.resolve("missing-media-extension"), before.signal)).rejects.toThrow("cancelled before")
    const during = new AbortController()
    const result = validate(cfg, during.signal)
    queueMicrotask(() => during.abort(new Error("cancelled during media qualification")))
    await expect(result).rejects.toThrow("cancelled during")
  } finally {
    await f.cleanup()
  }
})

test("dependency qualification permits explicitly inventoried bytecode and refuses case duplicates", async () => {
  const f = await fixture()
  try {
    await mkdir(path.join(f.dependencies, "__pycache__"))
    await writeFile(path.join(f.dependencies, "__pycache__", "selected.pyc"), "selected bytecode")
    const files = [
      { path: "selected.py", bytes: 8, sha256: sha("selected") },
      { path: "__pycache__/selected.pyc", bytes: 17, sha256: sha("selected bytecode") },
    ]
    // A complete dependency set reaches the deliberately unapproved interpreter, without importing it.
    await expect(validate(await f.publish(files))).rejects.toThrow("runtime metadata changed")
    await expect(validate(await f.publish([...files, { ...files[0], path: "SELECTED.py" }]))).rejects.toThrow(
      "Duplicate runtime inventory paths",
    )
  } finally {
    await f.cleanup()
  }
})

test("package catalog fails closed for missing executable sources", async () => {
  await expect(sources(path.resolve("missing-media-extension"))).rejects.toThrow()
})

test("frozen media cohort matches actual sources independently of the retained Memory release", async () => {
  const extension = path.resolve(import.meta.dir, "../..")
  const value = await sources(extension)
  expect(Object.keys(value.sources).sort()).toEqual([
    "encoder.py",
    "library.py",
    "owner.py",
    "session.py",
    "supervisor.py",
    "worker.py",
  ])
  for (const row of Object.values(value.sources)) {
    const raw = await readFile(row.path)
    expect(raw.length).toBe(row.bytes)
    expect(sha(raw)).toBe(row.sha256)
  }
  expect(Object.keys(release)).toHaveLength(13)
  expect(fingerprint(release)).toBe("5925615e1b3ce64155a01fad2f1cb02fba7ee6d808901e80f312678b8f68c747")
  expect(supervisors).toContain("7c2286962a606fade513e4742369d0f084609549961650347b89f44f1f266bcd")
  expect(sha(await readFile(path.join(extension, "script/memory/supervise.py")))).toBe(current)
  const f = await fixture()
  try {
    for (const row of Object.values(value.sources)) {
      const target = path.join(f.dir, path.relative(extension, row.path))
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(row.path, target)
    }
    expect((await sources(f.dir)).release).toBe(value.release)
    await writeFile(path.join(f.dir, "script/memory/media/worker.py"), "foreign worker")
    await expect(sources(f.dir)).rejects.toThrow("frozen release")
  } finally {
    await f.cleanup()
  }
})

async function selected() {
  const f = await owned()
  const cfg = await f.selected()
  const folder = path.join(f.root, "metadata")
  await space(folder, cfg.namespaces.retrieval.sid)
  const value = await prepare(cfg, folder)
  return { f, value }
}

test("pure dependency qualification binds actual code bytes and refuses changed, added or omitted files", async () => {
  const { f, value } = await selected()
  try {
    const proof = await dependencies(value.runtime)
    expect(proof.runtime).toEqual(value.runtime)
    expect(proof.inventory.files).toHaveLength(1)
    expect(proof.model.source).toBe("google/embeddinggemma-2")
    await fresh(proof)
    await expect(fresh(structuredClone(proof))).rejects.toThrow("Original")
    await writeFile(f.pyc, "changed dependency now")
    await expect(fresh(proof)).rejects.toThrow("leaf changed")
    await expect(dependencies(value.runtime)).rejects.toThrow("digest differs")
    await writeFile(f.pyc, "owned dependency bytes")
    await expect(fresh(proof)).rejects.toThrow("leaf changed")
    const restored = await dependencies(value.runtime)
    await writeFile(path.join(f.deps, "ambient.pyc"), "")
    await expect(fresh(restored)).rejects.toThrow("inventory changed")
    await expect(dependencies(value.runtime)).rejects.toThrow("incomplete")
    await rm(path.join(f.deps, "ambient.pyc"))
    await rm(f.pyc)
    await expect(dependencies(value.runtime)).rejects.toThrow("incomplete")
  } finally {
    await f.cleanup()
  }
})

test("bound dependency snapshot rejects changed manifest, inventory metadata and snapshot tampering without reading checkpoints", async () => {
  const { f, value } = await selected()
  try {
    const proof = await dependencies(value.runtime)
    const original = await readFile(value.runtime.model.path)
    await writeFile(value.runtime.model.path, Buffer.concat([original, Buffer.from(" ")]))
    await expect(fresh(proof)).rejects.toThrow("metadata changed")
    await expect(dependencies(value.runtime)).rejects.toThrow("metadata changed")
    await writeFile(value.runtime.model.path, original)
    await expect(fresh(proof)).rejects.toThrow("metadata changed")
    const restored = await dependencies(value.runtime)
    restored.runtime.dependencies = path.join(f.root, "foreign")
    await expect(fresh(restored)).rejects.toThrow("Original")
    const latest = await dependencies(value.runtime)
    await writeFile(value.runtime.inventory.path, "{}")
    await expect(fresh(latest)).rejects.toThrow("metadata changed")
    await expect(dependencies(value.runtime)).rejects.toThrow("metadata changed")
  } finally {
    await f.cleanup()
  }
})

test("dependency generation rejects added empty directories and honors cancellation", async () => {
  const { f, value } = await selected()
  try {
    const proof = await dependencies(value.runtime)
    await mkdir(path.join(f.deps, "new-empty-generation"))
    await expect(fresh(proof)).rejects.toThrow("inventory changed")
    const cancel = new AbortController()
    cancel.abort(new Error("owned dependency cancellation"))
    await expect(dependencies(value.runtime, cancel.signal)).rejects.toThrow("owned dependency cancellation")
    await expect(fresh(proof, cancel.signal)).rejects.toThrow("owned dependency cancellation")
  } finally {
    await f.cleanup()
  }
})
