import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { inspect } from "../../src/second-brain/uncertain-sync-archive"
import { absent } from "../../src/second-brain/failed-archive"
import { image } from "../../src/second-brain/control/identity"
import { interpreter, current } from "../../src/second-brain/managed/catalog"
import { release } from "../../src/second-brain/control/catalog-capture"
import { fingerprint } from "../../src/second-brain/failed-repair"

test("uncertain Sync retains unknown outcome and refuses changed debt/pair or a live producer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-uncertain-sync-archive-"))
  try {
    const file = path.join(root, "managed-original.json")
    // This physical fixture describes a historical pair. It grants no runtime
    // admission and contains no fake terminal, closure or publication absence.
    await writeFile(file, JSON.stringify({ format: "raya.memory.managed.pair.originals", version: 2 }))
    const held = await image(file)
    const receipt = { path: file, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }
    const ref = (name: string, sha256: string) => ({ path: path.join(root, name), bytes: 1, sha256 })
    const space = (name: string) => ({
      root: path.join(root, name),
      sid: "S-1-5-21-1-2-3-4",
      generations: { root: ["1", "2", "3"], Runs: ["1", "4", "5"], Requests: ["1", "6", "7"] },
    })
    const setup = {
      format: "raya.memory.setup",
      version: 2,
      protocol: "raya.memory.operation.v2",
      origin: "http://127.0.0.1:8874",
      root: path.join(root, "notes"),
      source_sha256: release,
    }
    const entry = {
      setup,
      managed: {
        format: "raya.memory.managed.launch",
        version: 2,
        root,
        python: ref("python.exe", interpreter),
        supervisor: ref("supervise.py", current),
        plan: ref("plan.json", "a".repeat(64)),
        retrieval: ref("retrieval.json", "b".repeat(64)),
        namespaces: { memory: space("memory"), retrieval: space("retrieval") },
      },
      launch: { phase: "running", receipt },
    }
    const expected = "d".repeat(64)
    const request = {
      op: "sync",
      id: "e".repeat(32),
      root: setup.root,
      owner_epoch: "f".repeat(32),
      selected_release_sha256: fingerprint(release),
      source_sha256: release,
      expected,
      bodySHA: fingerprint({ force_rebuild: false, expected_policy_sha256: expected }),
    }
    const debt = {
      format: "raya.memory.control.uncertainty",
      version: 2,
      protocol: setup.protocol,
      root: setup.root,
      request,
    }
    const value = await inspect(entry, debt, receipt)
    expect(value.outcome).toBe("unknown")
    expect(value.selected.request).toBe(request.id)
    expect(Object.hasOwn(value, "terminal")).toBe(false)
    expect(Object.hasOwn(value, "closed")).toBe(false)
    for (const changed of [
      { ...request, op: "search" },
      { ...request, bodySHA: "0".repeat(64) },
    ])
      await expect(inspect(entry, { ...debt, request: changed }, receipt)).rejects.toThrow()
    await expect(inspect(entry, debt, { ...receipt, sha256: "0".repeat(64) })).rejects.toThrow()
    const error = await absent({ pids: [process.pid], ports: [] }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(AggregateError)
    const output = error && typeof error === "object" && "output" in error ? error.output : undefined
    expect(output && typeof output === "object" && "stderr" in output ? output.stderr : undefined).toContain(
      "Historical process or selected service port remains present",
    )
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(root).startsWith("raya-uncertain-sync-archive-")).toBe(true)
    await rm(root, { recursive: true })
  }
})
