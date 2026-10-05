import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { assertImage, withImage, type Image } from "../../src/kilocode/source-offline"

test.skipIf(process.platform !== "win32")(
  "native timestamp evidence belongs to the held original and immutable copy",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-native-timestamps-")))
    const tree = path.join(root, "tree")
    await mkdir(tree)
    await mkdir(path.join(root, "control"))
    const file = path.join(tree, "café 日本語 😀.md")
    const text = "# Facts\n- retained :: café 日本語 😀\n"
    await writeFile(file, text)
    await utimes(file, 946684800.123456, 946684800.123456)
    const before = await lstat(file, { bigint: true })
    const helper = path.join(root, "raya-process-host.exe")
    assert(process.env.RAYA_TEST_TIMESTAMP_HELPER, "Require explicitly private timestamp-capable helper")
    await copyFile(process.env.RAYA_TEST_TIMESTAMP_HELPER, helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const roots = [{ kind: "json" as const, path: tree }]
    const policy = { version: 1 as const, directories: [tree], files: [] }
    const held: { image?: Image } = {}
    await withImage(
      { roots, policy, registry: path.join(root, "control", "registry"), helper: { executable: helper, digest } },
      async (image) => {
        held.image = image
        const value = assertImage(image, roots)
        const record = value.files.find((item) => item.original === file)
        assert(record?.modified)
        expect(record.modified).toBe((before.mtimeNs / 100n + 116444736000000000n).toString())
        expect((await lstat(record.staged, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
        expect(await readFile(record.staged, "utf8")).toBe(text)
        await assert.rejects(utimes(file, 0, 0))
        await assert.rejects(utimes(record.staged, 0, 0))
        expect(value.directories).toBeDefined()
      },
    )
    expect(() => assertImage(held.image, roots)).toThrow("expired")
    const after = await lstat(file, { bigint: true })
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.ino).toBe(before.ino)
    expect(await readFile(file, "utf8")).toBe(text)
    await assert.rejects(
      withImage(
        { roots, policy, registry: path.join(root, "control", "registry"), helper: { executable: helper, digest } },
        async () => {
          throw new Error("Owned timestamp callback refused")
        },
      ),
      (err) =>
        err instanceof AggregateError &&
        err.errors.length === 1 &&
        err.errors[0] instanceof Error &&
        err.errors[0].message === "Owned timestamp callback refused",
    )
    expect((await lstat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
    await withImage(
      {
        roots,
        policy,
        registry: path.join(root, "control", "registry"),
        inventory: "directories",
        helper: { executable: helper, digest },
      },
      async (image) => {
        expect(assertImage(image, roots).files.every((item) => item.modified === undefined)).toBe(true)
        expect(assertImage(image, roots).directories).toBeDefined()
      },
    )
    const missing = path.join(root, "missing", "child")
    for (const selected of [roots, [...roots, { kind: "json" as const, path: missing }]])
      await withImage(
        {
          roots: selected,
          policy: { ...policy, files: [missing] },
          registry: path.join(root, "control", "registry"),
          inventory: "legacy",
          helper: { executable: helper, digest },
        },
        async (image) => {
          const value = assertImage(image, selected)
          expect(value.files.every((item) => item.modified === undefined)).toBe(true)
          expect(value.directories).toBeUndefined()
          if (selected.length === 2)
            expect(value.roots.find((item) => item.original === missing)?.absence).toBeDefined()
        },
      )
    await utimes(file, 0, 0)
    expect((await lstat(file, { bigint: true })).mtimeNs).toBe(0n)
  },
)
