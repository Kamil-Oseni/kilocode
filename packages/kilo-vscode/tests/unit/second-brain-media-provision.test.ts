import { expect, test } from "bun:test"
import path from "node:path"
import { writeFile, readFile, readdir } from "node:fs/promises"
import { derive, prepare } from "../../src/second-brain/media/provision"
import { catalogs, images } from "../../src/second-brain/managed/reuse-catalog"
import { sha } from "../../src/second-brain/control/frames"
import { space } from "../../src/second-brain/managed/generation"
import { image, environment } from "../../src/second-brain/control/identity"
import { protection } from "../../src/second-brain/managed/protection"
import { exec } from "../../src/util/process"

import { fixture } from "./fixtures/media-provision"

test("selected plan derives complete relative dependency metadata including bytecode without runtime authority", async () => {
  const f = await fixture()
  try {
    const { cfg, raw } = f.binding()
    const result = derive(cfg, raw)
    expect(result.qualified).toBe(false)
    expect(result.inference).toBe(false)
    expect(result.retrieval).toEqual(cfg.retrieval!)
    expect(result.python).toEqual(cfg.python)
    expect(result.inventory.files).toEqual([
      { path: "__pycache__/selected.cpython-312.pyc", bytes: 22, sha256: sha(await readFile(f.pyc)) },
    ])
    expect(result.model.path).toBe(path.join(f.root, "catalog", "google--embeddinggemma-2.json"))
    expect(result.model.sha256).toBe(catalogs["google--embeddinggemma-2.json"])
    expect(result.inventory.files[0]).not.toHaveProperty("identity")
    expect(() => derive(cfg, Buffer.from(raw.toString() + " "))).toThrow("bytes changed")
    expect(() => derive({ ...cfg, version: 1, retrieval: undefined }, raw)).toThrow()
  } finally {
    await f.cleanup()
  }
})

test("derivation rejects mixed releases, wrong protocol, root, Python and catalog selection", async () => {
  const f = await fixture()
  try {
    for (const plan of [
      { ...f.plan, retrieval_protocol: "legacy" },
      { ...f.plan, root: path.join(f.root, "other") },
      { ...f.plan, python_sha256: "a".repeat(64) },
      { ...f.plan, env: { RAYA_RETRIEVAL_RELEASE_SHA256: "a".repeat(64) } },
      { ...f.plan, source_sha256: { ...images, "retrieval_reuse/server.py": "a".repeat(64) } },
      { ...f.plan, files: f.plan.files.filter((row) => !row.path.endsWith("google--embeddinggemma-2.json")) },
      {
        ...f.plan,
        files: f.plan.files.map((row) =>
          row.path.endsWith("google--embeddinggemma-2.json") ? { ...row, sha256: images["retrieval/models.py"] } : row,
        ),
      },
      { ...f.plan, files: [...f.plan.files, f.plan.files[1]] },
      { ...f.plan, files: f.plan.files.map((row) => (row.path === f.plan.files[0].path ? { ...row, bytes: 1 } : row)) },
    ]) {
      const { cfg, raw } = f.binding(plan)
      expect(() => derive(cfg, raw)).toThrow()
    }
  } finally {
    await f.cleanup()
  }
})

test("preparation cancellation and unprotected destination fail before any metadata publication", async () => {
  const f = await fixture()
  try {
    const { cfg } = f.binding()
    const cancel = new AbortController()
    cancel.abort(new Error("owned cancellation"))
    await expect(prepare(cfg, f.root, cancel.signal)).rejects.toThrow("owned cancellation")
    await expect(prepare(cfg, f.root)).rejects.toThrow()
    expect(await readFile(f.pyc, "utf8")).toBe("owned dependency bytes")
  } finally {
    await f.cleanup()
  }
})

test("owned private metadata publication exceeds the old 64KiB cap, reads back exactly and rejects changed dependencies", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 400; i++) {
      const target = path.join(f.deps, `${i}-` + "selected".repeat(20) + ".pyc")
      await writeFile(target, "")
      f.plan.files.push({ path: target, bytes: 0, sha256: sha("") })
    }
    const cfg = await f.selected()
    const sid = cfg.namespaces.retrieval.sid
    const folder = path.join(f.root, "metadata")
    await space(folder, sid)
    const result = await prepare(cfg, folder)
    expect(result.qualified).toBe(false)
    expect(result.inference).toBe(false)
    expect(result.runtime.inventory.bytes).toBeGreaterThan(65536)
    const inventory = await image(result.runtime.inventory.path, 16777216)
    expect(inventory.raw.length).toBe(result.runtime.inventory.bytes)
    expect(inventory.digest).toBe(result.runtime.inventory.sha256)
    expect(JSON.parse(inventory.raw.toString()).files).toHaveLength(401)
    const runtime = await image(result.selected.path, 16777216)
    expect(runtime.digest).toBe(result.selected.sha256)
    expect(JSON.parse(runtime.raw.toString())).toEqual(result.runtime)
    expect(result.provenance.retrieval.sha256).toBe(cfg.retrieval!.sha256)
    await expect(prepare(cfg, folder)).rejects.toThrow("Empty selected-owner")
    const second = path.join(f.root, "metadata-second")
    await space(second, sid)
    await writeFile(f.pyc, "changed dependency now")
    await expect(prepare(cfg, second)).rejects.toThrow("bytes changed")
    expect((await readdir(second)).sort()).toEqual(["Requests", "Runs"])
    const third = path.join(f.root, "metadata-third")
    await space(third, sid)
    await writeFile(path.join(f.deps, "ambient.pyc"), "")
    await expect(prepare(cfg, third)).rejects.toThrow("incomplete")
    expect((await readdir(third)).sort()).toEqual(["Requests", "Runs"])
  } finally {
    await f.cleanup()
  }
}, 30000)

test("optional contained fixture has an actual protected owned stdlib interpreter without installed model packages", async () => {
  const f = await fixture({ contained: true })
  try {
    const cfg = await f.selected()
    expect(await protection(cfg.root)).toBe(cfg.namespaces.retrieval.sid)
    const held = await image(cfg.python.path, 16777216)
    expect(held.digest).toBe(cfg.python.sha256)
    const result = await exec(
      cfg.python.path,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import json,sys,importlib.util;print(json.dumps({'executable':sys.executable,'torch':importlib.util.find_spec('torch') is None}))",
      ],
      { env: environment(), timeout: 10000, maxBuffer: 4096 },
    )
    const value = JSON.parse(result.stdout)
    expect(path.resolve(value.executable)).toBe(path.resolve(cfg.python.path))
    expect(value.torch).toBe(true)
    expect(result.stderr).toBe("")
  } finally {
    await f.cleanup()
  }
}, 30000)
