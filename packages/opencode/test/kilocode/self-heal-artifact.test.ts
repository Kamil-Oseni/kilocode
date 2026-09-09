import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Build, load } from "@/kilocode/self-heal/build-input"
import { capture, materialize } from "@/kilocode/self-heal/snapshot"
import { inspect } from "@/kilocode/self-heal/artifact-inspect"
import { checkout } from "./fixtures/self-heal-worktree"
import { archive } from "./fixtures/self-heal-artifact"

test("private captured build input rejects source drift and independently checks VSIX identity and bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-artifact-test-"))
  try {
    const source = await checkout(path.join(root, "storage"))
    const store = path.join(root, "snapshots")
    const snapshot = await capture(source.root, store)
    const directory = await materialize(store, snapshot)
    const input = Schema.decodeUnknownSync(Build)({
      version: 1,
      id: randomUUID(),
      itemID: "item",
      attemptID: "attempt",
      completion: "a".repeat(64),
      checks: ["check"],
      snapshot,
      directory,
      output: path.join(directory, ".git", "artifact.vsix"),
      target: `${process.platform}-${process.arch}`,
      extension: "1.2.3-repair+abcd",
      cli: "1.2.3-repair+abcd",
      at: Date.now(),
    })
    const file = path.join(directory, ".git", "input.json")
    await fs.writeFile(file, JSON.stringify(input))
    expect((await load(directory, file))?.snapshot.digest).toBe(snapshot.digest)
    await expect(load(source.root, file)).rejects.toThrow("different checkout")
    await archive(input)
    expect((await inspect(input)).artifact.size).toBeGreaterThan(0)
    for (const mode of ["source", "binary", "target", "duplicate"] as const) {
      await archive(input, mode)
      await expect(inspect(input)).rejects.toThrow()
    }
    await fs.writeFile(path.join(directory, "tracked.txt"), "untested bytes")
    await expect(load(directory, file)).rejects.toThrow("changed")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
