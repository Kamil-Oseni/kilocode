import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { assertImage, withImage, type Image } from "../../src/kilocode/source-offline"
import { directoryInventory, validateDirectoryInventory } from "../../src/kilocode/source-image-directories"
import { preparation } from "../../src/kilocode/source-offline-frame"

test.skipIf(process.platform !== "win32")(
  "native directory traversal proves empty nested trees without negative sibling capture",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-native-directories-")))
    const tree = path.join(root, "tree")
    const empty = path.join(tree, "café 日本語 😀", "empty")
    await mkdir(empty, { recursive: true })
    const file = path.join(tree, "café 日本語 😀", "content.md")
    await writeFile(file, "# café 日本語 😀\n")
    await writeFile(path.join(tree, "zero.txt"), "")
    const sibling = path.join(root, "unselected-sibling.txt")
    await writeFile(sibling, "Never enumerate or capture this sibling")
    const before = await readFile(sibling)
    const missing = path.join(root, "absent", "nested")
    await mkdir(path.join(root, "control"))
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_TEST_DIRECTORY_HELPER ??
        path.resolve(import.meta.dir, "../../native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const roots = [
      { kind: "json" as const, path: tree },
      { kind: "json" as const, path: missing },
    ]
    const policy = { version: 1 as const, directories: [tree], files: [missing] }
    const registry = path.join(root, "control", "registry")
    const held: { image?: Image } = {}
    await withImage({ roots, policy, registry, helper: { executable: helper, digest } }, async (image) => {
      held.image = image
      const value = assertImage(image, roots)
      assert(value.directories)
      expect(value.directories.map((item) => item.original).sort()).toEqual([tree, path.dirname(empty), empty].sort())
      const record = value.directories.find((item) => item.original === empty)!
      expect(record.children).toHaveLength(0)
      expect(record.volume).toBeGreaterThanOrEqual(0)
      expect(record.index).toMatch(/^\d+$/)
      expect(value.files.find((item) => item.original.endsWith("zero.txt"))?.bytes).toBe(0)
      expect(value.directories.some((item) => item.original === root || item.original === missing)).toBe(false)
      expect(value.files.some((item) => item.original === sibling)).toBe(false)
      expect(value.roots.find((item) => item.original === missing)?.absence).toBeDefined()
      expect(Object.isFrozen(record.children)).toBe(true)
      await assert.rejects(writeFile(path.join(record.staged, "intruder.txt"), "late"))
      await assert.rejects(mkdir(path.join(record.staged, "intruder")))
      await assert.rejects(rename(empty, empty + "-rebound"))
      const positive = value.roots.filter((item) => !item.absence)
      await assert.rejects(
        validateDirectoryInventory(
          positive,
          value.files,
          value.directories.map((item) => (item.original === tree ? { ...item, children: [] } : item)),
        ),
        /child set differs/,
      )
      await assert.rejects(
        validateDirectoryInventory(
          positive,
          value.files,
          value.directories.map((item) =>
            item.original === tree
              ? { ...item, children: item.children.map((child) => ({ ...child, index: "0" })) }
              : item,
          ),
        ),
        /object linkage/,
      )
      await assert.rejects(
        validateDirectoryInventory(
          positive,
          value.files,
          value.directories.filter((item) => item.original !== empty),
        ),
        /object linkage/,
      )
      expect(
        directoryInventory.safeParse(
          value.directories.map((item) => ({
            ...item,
            children: [{ name: "../escape", directory: true, volume: 0, index: "0" }],
          })),
        ).success,
      ).toBe(false)
    })
    expect(() => assertImage(held.image, roots)).toThrow("expired")
    expect(await readFile(sibling)).toEqual(before)
    expect(await readFile(file, "utf8")).toBe("# café 日本語 😀\n")
    await writeFile(path.join(empty, "after.txt"), "permissions restored")
    for (const selected of [[roots[0]], roots]) {
      await withImage(
        { roots: selected, policy, registry, inventory: "legacy", helper: { executable: helper, digest } },
        async (image) => {
          expect(assertImage(image, selected).directories).toBeUndefined()
        },
      )
    }
    const generation = crypto.randomUUID()
    expect(() =>
      preparation(
        {
          version: 3,
          generation,
          state: "retired",
          restored: true,
          failures: ["Offline directory inventory exceeded bound"],
          portableCaptureAuthorized: false,
        },
        generation,
        3,
      ),
    ).toThrow(AggregateError)
    expect(() =>
      preparation(
        { version: 3, generation, state: "retired", restored: true, failures: [], portableCaptureAuthorized: false },
        generation,
        2,
      ),
    ).toThrow("refused")
  },
  60000,
)
