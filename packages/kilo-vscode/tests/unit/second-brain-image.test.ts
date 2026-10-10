import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { appendFileSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { image } from "../../src/second-brain/control/identity"
import { sha } from "../../src/second-brain/control/frames"

async function fixture(body: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "raya-image-bound-"))
  const file = path.join(root, "image.bin")
  await writeFile(file, "original")
  try {
    await body(root, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("real small image allocates its actual bytes plus one under the 512 MiB selection maximum", async () => {
  await fixture(async (_root, file) => {
    const original = Buffer.alloc
    const sizes: number[] = []
    const spy = spyOn(Buffer, "alloc").mockImplementation((size, ...args) => {
      sizes.push(size)
      return original(size, ...args)
    })
    try {
      const held = await image(file, 536870912)
      expect(held.raw.toString()).toBe("original")
      expect(held.digest).toBe(sha("original"))
      expect(held.tuple.split(":")[3]).toBe("8")
      expect(sizes).toEqual([9])
    } finally {
      spy.mockRestore()
    }
  })
})

for (const change of ["grow", "shrink", "overwrite", "replace"])
  test(`same opened real image refuses ${change} after the initial handle stat`, async () => {
    await fixture(async (_root, file) => {
      const original = Buffer.alloc
      const spy = spyOn(Buffer, "alloc").mockImplementation((size, ...args) => {
        spy.mockRestore()
        if (change === "grow") appendFileSync(file, "extra")
        if (change === "shrink") truncateSync(file, 1)
        if (change === "overwrite") {
          writeFileSync(file, "changed!")
          utimesSync(file, new Date(0), new Date(0))
        }
        if (change === "replace") {
          unlinkSync(file)
          writeFileSync(file, "original")
        }
        return original(size, ...args)
      })
      try {
        await expect(image(file, 536870912)).rejects.toThrow()
      } finally {
        spy.mockRestore()
      }
    })
  })

test("real oversize and hard-linked images refuse before allocation", async () => {
  await fixture(async (root, file) => {
    const spy = spyOn(Buffer, "alloc")
    try {
      await expect(image(file, 7)).rejects.toThrow("Bounded single-link image required")
      await link(file, path.join(root, "alias.bin"))
      await expect(image(file, 536870912)).rejects.toThrow("Bounded single-link image required")
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

test("real directory junction or symlink remains refused as an image", async () => {
  await fixture(async (root) => {
    const alias = path.join(root, "alias")
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(image(alias, 536870912)).rejects.toThrow("Bounded single-link image required")
  })
})
