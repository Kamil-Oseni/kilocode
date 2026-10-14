import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { release, bridge, selected, resident, transport } from "../../src/second-brain/control/catalog-capture"
import { release as legacy, bridge as prior } from "../../src/second-brain/control/catalog-v2"
import { compatible, current, paired, supervisors } from "../../src/second-brain/managed/catalog"

const captured = selected({
  "capture.py": "b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe",
  "server.py": "ddcffa6ec22432f1622850aa36e04e48cfe8cad94db28648e1b6b8dd2fefcf1d",
  "index.py": "3c106c8e45267ee808a3c2bd8dfacf85a4d3c1ca47e23785706d7663d6791f65",
})
const warning = {
  ...release,
  "index.py": "0bd829a079d6de51f1c8b6d80d3e466d8b093ed9e0b5862a6216db2566e1aa73",
  "capture.py": "b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe",
  "entries.py": "20b59cdc4a4ea3b5124ee81c0950ffbb6429ba05dcd6f0ac8d9d8656c2a13472",
}

test("preference reference successor preserves all exact fifteen-file predecessor supervisor pairings", () => {
  const previous = {
    ...warning,
    "index.py": "b6bd48d00bca2565c8c6690691b7f9b1e2e7680abbd48058ab62b4a2770ef5cd",
  }
  const original = JSON.stringify(previous)
  const managed = {
    ...previous,
    "historical.py": "2d97c96d13b906d8aadcae47a89704cb1b839f5e09da144ca28bd20a0af779bc",
  }
  const retained = "e971a2f6678b9ede506ec656ca13fec8a1dedeea4239524bd39186c337fb2da7"
  const prior = "f9b6762a5bb729c7d04fe5e20821fefa420ec2be1934986d73d47664b217071c"
  const recalled = { ...warning, "index.py": "699f9d1af1083e9b751b5c08ed71077bafd9809fa1d32918d276e202770aa96c" }
  const reader = "957a6b9ce25bdb1d7ce629fb72e8cac97c70cffe98877f9ca3ebb57a0adb63ac"
  const diverse = { ...warning, "index.py": "008f7051d51cdd7bd0edaa2802630ce87b09766be470d9b8f2b3dc494677889e" }
  const digest = "f3aed8eaa2bfcfac00608a4eed05258764745251f9378880f63ccac4e576d518"
  for (const [pins, supervisor] of [
    [release, current],
    [
      { ...release, "index.py": warning["index.py"] },
      "6d0d531c4495b37c30a808b935d8754566849e0d3eb7ca74f0f99b7453ab6c49",
    ],
    [warning, "fe3139b3ba5f75beb5229dfe049a38ba44031ce00b17169e8a53b0ceef694de2"],
    [diverse, digest],
    [recalled, reader],
    [previous, retained],
    [managed, prior],
  ] as const) {
    expect(selected(pins)).toEqual(pins)
    expect(resident(pins)).toBe(true)
    expect(transport(pins)).toBe(bridge)
    expect(paired(supervisor)).toBe(true)
    expect(compatible(pins, supervisor)).toBe(true)
    for (const other of [
      current,
      "6d0d531c4495b37c30a808b935d8754566849e0d3eb7ca74f0f99b7453ab6c49",
      "fe3139b3ba5f75beb5229dfe049a38ba44031ce00b17169e8a53b0ceef694de2",
      digest,
      reader,
      retained,
      prior,
    ].filter((value) => value !== supervisor))
      expect(compatible(pins, other)).toBe(false)
    expect(
      compatible({ ...pins, "capture.py": release["capture.py"], "entries.py": warning["entries.py"] }, supervisor),
    ).toBe(false)
    expect(compatible({ ...pins, "index.py": "f".repeat(64) }, supervisor)).toBe(false)
  }
  expect(JSON.stringify(previous)).toBe(original)
})

test("personal management catalog pins actual fifteen-file source and preserves legacy transport", async () => {
  const source = path.resolve("script/memory/service")
  const file = path.resolve("script/memory/control.py")
  const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex")
  await Promise.all(
    Object.entries(release).map(async ([name, digest]) => {
      expect(sha(await readFile(path.join(source, name)))).toBe(digest)
    }),
  )
  expect(sha(await readFile(file))).toBe(bridge)
  expect(sha(await readFile(path.resolve("script/memory/supervise.py")))).toBe(current)
  expect(supervisors).toContain(current)
  const cfg = {
    format: "raya.memory.control.catalog",
    version: 2,
    python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
    python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
    source,
    bridge: file,
    bridge_sha256: bridge,
    source_sha256: release,
  }
  expect(parseCatalog(cfg).source_sha256).toEqual(release)
  expect(Object.keys(release)).toHaveLength(15)
  expect(parseCatalog({ ...cfg, bridge_sha256: transport(captured), source_sha256: captured }).source_sha256).toEqual(
    captured,
  )
  expect(() => parseCatalog({ ...cfg, source_sha256: captured })).toThrow()
  const retained = selected({
    ...captured,
    "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e",
  })
  expect(parseCatalog({ ...cfg, bridge_sha256: transport(retained), source_sha256: retained }).source_sha256).toEqual(
    retained,
  )
  const indexed = selected({
    ...captured,
    "index.py": "8ae8274ff8f46f906efc9c6c5e2dbd2445315f27dc371bd07485fb71635f20f3",
  })
  expect(parseCatalog({ ...cfg, bridge_sha256: transport(indexed), source_sha256: indexed }).source_sha256).toEqual(
    indexed,
  )
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...indexed, "server.py": "f".repeat(64) } })).toThrow()
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...retained, "capture.py": "f".repeat(64) } })).toThrow()
  expect(parseCatalog({ ...cfg, bridge_sha256: prior, source_sha256: legacy }).source_sha256).toEqual(legacy)
  expect(() => parseCatalog({ ...cfg, bridge_sha256: prior })).toThrow()
  expect(() => parseCatalog({ ...cfg, source_sha256: { ...release, "capture.py": "f".repeat(64) } })).toThrow()
})

test("personal management release preserves complete resident capture cohorts", () => {
  const previous = { ...captured, "index.py": "e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7" }
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
  ).toEqual(["server.py", "index.py", "historical.py", "capture.py", "entries.py", "management.py"])
  const cfg = {
    format: "raya.memory.control.catalog",
    version: 2,
    python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
    python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
    source: path.resolve("script/memory/service"),
    bridge: path.resolve("script/memory/control.py"),
    bridge_sha256: transport(previous),
    source_sha256: previous,
  }
  expect(parseCatalog(cfg).source_sha256).toEqual(previous)
  expect(parseCatalog({ ...cfg, bridge_sha256: bridge, source_sha256: release }).source_sha256).toEqual(release)
  for (const source of [previous, release]) {
    for (const corrupt of [
      { ...source, "index.py": "f".repeat(64) },
      { ...source, "capture.py": "f".repeat(64) },
      { ...source, "server.py": "f".repeat(64) },
      { ...source, "extra.py": "f".repeat(64) },
      Object.fromEntries(Object.entries(source).filter(([name]) => name !== "capture.py")),
    ]) {
      expect(resident(corrupt)).toBe(false)
      expect(() => parseCatalog({ ...cfg, bridge_sha256: transport(source), source_sha256: corrupt })).toThrow()
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
}, 20000)
