import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { release, bridge } from "../../src/second-brain/control/catalog-capture"
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
  const retained = { ...release, "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e" }
  expect(parseCatalog({ ...cfg, source_sha256: retained }).source_sha256).toEqual(retained)
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...retained, "capture.py": "f".repeat(64) } })).toThrow()
  expect(parseCatalog({ ...cfg, bridge_sha256: prior, source_sha256: legacy }).source_sha256).toEqual(legacy)
  expect(() => parseCatalog({ ...cfg, bridge_sha256: prior })).toThrow()
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...release, "capture.py": "f".repeat(64) } })).toThrow()
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
