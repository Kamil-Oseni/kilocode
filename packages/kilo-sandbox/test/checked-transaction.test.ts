import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { cleanup, commit, rollback, stage, type Entry, type Proof } from "../src/checked-transaction"

const roots: string[] = []
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const exists = (target: string) => Bun.file(target).exists()

async function proof(target: string): Promise<Proof> {
  const info = await stat(target, { bigint: true })
  return {
    identity: { dev: info.dev.toString(), ino: info.ino.toString() },
    sha256: createHash("sha256")
      .update(await readFile(target))
      .digest("hex"),
  }
}

async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-transaction-"))
  roots.push(dir)
  return dir
}

function paths(root: string, name: string) {
  return {
    target: path.join(root, `${name}.txt`),
    stage: path.join(root, `.raya-txn-${name}.stage`),
    hold: path.join(root, `.raya-txn-${name}.hold`),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("checked transaction files", () => {
  test("rolls a mixed create, replace and remove transaction back in reverse", async () => {
    const dir = await root()
    const replacement = paths(dir, "replace")
    const removal = paths(dir, "remove")
    const creation = paths(dir, "create")
    await writeFile(replacement.target, "before replacement")
    await writeFile(removal.target, "before removal")
    const anchor = await stat(dir, { bigint: true })
    const entries: Entry[] = [
      {
        kind: "replace",
        ...replacement,
        review: await proof(replacement.target),
        result: { sha256: hash("after replacement") },
      },
      {
        kind: "remove",
        target: removal.target,
        hold: removal.hold,
        review: await proof(removal.target),
      },
      {
        kind: "create",
        target: creation.target,
        stage: creation.stage,
        result: { sha256: hash("created") },
        anchor: { path: dir, identity: { dev: anchor.dev.toString(), ino: anchor.ino.toString() } },
      },
    ]
    entries[0] = { ...entries[0], artifact: await stage(entries[0], Buffer.from("after replacement")) }
    entries[2] = { ...entries[2], artifact: await stage(entries[2], Buffer.from("created")) }
    for (const entry of entries) await commit(entry)

    expect(await readFile(replacement.target, "utf8")).toBe("after replacement")
    expect(await exists(removal.target)).toBe(false)
    expect(await readFile(creation.target, "utf8")).toBe("created")

    for (const entry of entries.toReversed()) await rollback(entry)
    for (const entry of entries) await cleanup(entry, false)
    expect(await readFile(replacement.target, "utf8")).toBe("before replacement")
    expect(await readFile(removal.target, "utf8")).toBe("before removal")
    expect(await exists(creation.target)).toBe(false)
    expect((await readdir(dir)).some((name) => name.startsWith(".raya-txn-"))).toBe(false)
  })

  test("keeps committed postimages until the durable decision then removes only owned sidecars", async () => {
    const dir = await root()
    const file = paths(dir, "value")
    await writeFile(file.target, "before")
    let entry: Entry = {
      kind: "replace",
      ...file,
      review: await proof(file.target),
      result: { sha256: hash("after") },
    }
    entry = { ...entry, artifact: await stage(entry, Buffer.from("after")) }
    await commit(entry)
    await cleanup(entry, true)
    expect(await readFile(file.target, "utf8")).toBe("after")
    expect(await exists(file.stage)).toBe(false)
    expect(await exists(file.hold)).toBe(false)
  })

  test("preserves a competing pathname and retains recovery evidence", async () => {
    const dir = await root()
    const file = paths(dir, "conflict")
    await writeFile(file.target, "before")
    let entry: Entry = {
      kind: "replace",
      ...file,
      review: await proof(file.target),
      result: { sha256: hash("after") },
    }
    entry = { ...entry, artifact: await stage(entry, Buffer.from("after")) }
    await commit(entry)
    await rm(file.target)
    await writeFile(file.target, "newer user file")

    await expect(rollback(entry)).rejects.toThrow("newer user work")
    expect(await readFile(file.target, "utf8")).toBe("newer user file")
    expect(await readFile(file.hold, "utf8")).toBe("before")
    expect(await readFile(file.stage, "utf8")).toBe("after")
  })

  test("restores newer bytes written through the displaced inode", async () => {
    const dir = await root()
    const file = paths(dir, "handle")
    await writeFile(file.target, "before")
    let entry: Entry = {
      kind: "replace",
      ...file,
      review: await proof(file.target),
      result: { sha256: hash("after") },
    }
    entry = { ...entry, artifact: await stage(entry, Buffer.from("after")) }
    await commit(entry)
    await writeFile(file.hold, "newer bytes through old inode")

    await expect(cleanup(entry, true)).rejects.toThrow("was restored")
    expect(await readFile(file.target, "utf8")).toBe("newer bytes through old inode")
    expect(await exists(file.hold)).toBe(false)
    expect(await exists(file.stage)).toBe(false)
  })

  test("refuses hard-linked stages and malformed sidecar ownership", async () => {
    const dir = await root()
    const file = paths(dir, "linked")
    const alias = path.join(dir, "alias")
    await writeFile(file.target, "before")
    let entry: Entry = {
      kind: "replace",
      ...file,
      review: await proof(file.target),
      result: { sha256: hash("after") },
    }
    entry = { ...entry, artifact: await stage(entry, Buffer.from("after")) }
    await link(file.stage, alias)
    await expect(commit(entry)).rejects.toThrow("stage changed")
    expect(await exists(file.target)).toBe(false)
    expect(await readFile(file.hold, "utf8")).toBe("before")
    await rollback(entry)
    expect(await readFile(file.target, "utf8")).toBe("before")
    await expect(commit({ ...entry, stage: path.join(dir, "ordinary.tmp") })).rejects.toThrow("sidecar name")
  })
})
