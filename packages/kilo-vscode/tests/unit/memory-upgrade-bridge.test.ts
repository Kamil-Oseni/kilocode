import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { release, selected, transport as previous } from "../../src/second-brain/control/catalog-capture"
import { parseCatalog } from "../../src/second-brain/control/catalog"
import { transport } from "../../src/second-brain/managed/upgrade-bridge"

test("paired upgrade selects the actual immutable current bridge and refuses stale or changed images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-upgrade-bridge-"))
  try {
    const pins = selected({
      "capture.py": release["capture.py"],
      "server.py": "ddcffa6ec22432f1622850aa36e04e48cfe8cad94db28648e1b6b8dd2fefcf1d",
      "index.py": "3c106c8e45267ee808a3c2bd8dfacf85a4d3c1ca47e23785706d7663d6791f65",
    })
    const prior = parseCatalog({
      format: "raya.memory.control.catalog",
      version: 2,
      python: path.join(root, "python.exe"),
      source: root,
      bridge: path.join(root, "old-control.py"),
      python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
      bridge_sha256: previous(pins),
      source_sha256: pins,
    })
    const raw = await readFile(path.resolve("script/memory/control.py"))
    const file = path.join(root, "control.py")
    await writeFile(file, raw, { flag: "wx" })
    const ref = { path: file, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }
    const proof = { source: root, images: [ref], next: { setup: { source_sha256: release } } }
    expect(() => parseCatalog({ ...prior, source_sha256: release })).toThrow("Unreviewed control release refused")
    expect(await transport(prior, proof)).toMatchObject({
      bridge: file,
      bridge_sha256: ref.sha256,
      source_sha256: release,
    })
    await expect(transport(prior, { ...proof, images: [] })).rejects.toThrow("Reviewed upgrade control bridge required")
    await expect(transport(prior, { ...proof, images: [{ ...ref, sha256: prior.bridge_sha256 }] })).rejects.toThrow(
      "Reviewed upgrade control bridge required",
    )
    await writeFile(file, Buffer.concat([raw, Buffer.from("\n# changed\n")]))
    await expect(transport(prior, proof)).rejects.toThrow("Reviewed upgrade control bridge changed")
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()))
    await rm(root, { recursive: true })
  }
})
