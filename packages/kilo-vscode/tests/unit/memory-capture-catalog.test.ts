import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { release, bridge, selected, resident } from "../../src/second-brain/control/catalog-capture"
import { release as legacy, bridge as prior } from "../../src/second-brain/control/catalog-v2"
import { supervisors } from "../../src/second-brain/managed/catalog"

test("capture catalog pins actual thirteen-file source and preserves separate legacy selection", async () => {
  const source = path.resolve("script/memory/service")
  const transport = path.resolve("script/memory/control.py")
  const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex")
  await Promise.all(
    Object.entries(release).map(async ([name, digest]) => {
      expect(sha(await readFile(path.join(source, name)))).toBe(digest)
    }),
  )
  expect(sha(await readFile(transport))).toBe(bridge)
  expect(supervisors).toContain(sha(await readFile(path.resolve("script/memory/supervise.py"))))
  const cfg = {
    format: "raya.memory.control.catalog",
    version: 2,
    python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
    python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
    source,
    bridge: transport,
    bridge_sha256: bridge,
    source_sha256: release,
  }
  expect(parseCatalog(cfg).source_sha256).toEqual(release)
  const retained = selected({
    ...release,
    "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e",
  })
  expect(parseCatalog({ ...cfg, source_sha256: retained }).source_sha256).toEqual(retained)
  const indexed = selected({
    ...release,
    "index.py": "8ae8274ff8f46f906efc9c6c5e2dbd2445315f27dc371bd07485fb71635f20f3",
  })
  expect(parseCatalog({ ...cfg, source_sha256: indexed }).source_sha256).toEqual(indexed)
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...indexed, "server.py": "f".repeat(64) } })).toThrow()
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...retained, "capture.py": "f".repeat(64) } })).toThrow()
  expect(parseCatalog({ ...cfg, bridge_sha256: prior, source_sha256: legacy }).source_sha256).toEqual(legacy)
  expect(() => parseCatalog({ ...cfg, bridge_sha256: prior })).toThrow()
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...release, "capture.py": "f".repeat(64) } })).toThrow()
})

test("recall passage release preserves the complete previous resident capture cohort", () => {
  const previous = { ...release, "index.py": "e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7" }
  const held = JSON.stringify(previous)
  expect(selected(previous)).toEqual(previous)
  expect(resident(previous)).toBe(true)
  expect(selected(release)).toEqual(release)
  expect(resident(release)).toBe(true)
  expect(Object.isFrozen(selected(previous))).toBe(true)
  expect(Object.isFrozen(release)).toBe(true)
  expect(
    Object.entries(release)
      .filter(([name, hash]) => previous[name as keyof typeof previous] !== hash)
      .map(([name]) => name),
  ).toEqual(["index.py"])
  const cfg = {
    format: "raya.memory.control.catalog",
    version: 2,
    python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
    python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
    source: path.resolve("script/memory/service"),
    bridge: path.resolve("script/memory/control.py"),
    bridge_sha256: bridge,
    source_sha256: previous,
  }
  expect(parseCatalog(cfg).source_sha256).toEqual(previous)
  expect(parseCatalog({ ...cfg, source_sha256: release }).source_sha256).toEqual(release)
  for (const source of [previous, release]) {
    for (const corrupt of [
      { ...source, "index.py": "f".repeat(64) },
      { ...source, "capture.py": "f".repeat(64) },
      { ...source, "server.py": "f".repeat(64) },
      { ...source, "extra.py": "f".repeat(64) },
      Object.fromEntries(Object.entries(source).filter(([name]) => name !== "capture.py")),
    ]) {
      expect(resident(corrupt)).toBe(false)
      expect(() => parseCatalog({ ...cfg, source_sha256: corrupt })).toThrow()
    }
  }
  expect(JSON.stringify(previous)).toBe(held)
})

test("actual supervisor accepts only the exact current or preserved legacy release", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      "-I",
      "-S",
      "-B",
      path.resolve("script/memory/capture_release_test.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toContain("OK")
})
