import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, open, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { digest } from "../../src/kilocode/file-digest"

async function refuses(job: Promise<string>, text?: string) {
  const result = await job.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(result).toBeInstanceOf(Error)
  if (text) expect(result).toMatchObject({ message: expect.stringContaining(text) })
}

test("file digest preserves known SHA256 vectors and fresh content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-digest-"))
  const file = path.join(root, "image")
  await writeFile(file, "")
  expect(await digest(file)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  await writeFile(file, "abc")
  expect(await digest(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  const bytes = Buffer.alloc(1048576 * 3 + 17, 0x83)
  bytes[1048575] = 0
  bytes[1048576] = 0xff
  await writeFile(file, bytes)
  expect(await digest(file)).toBe(createHash("sha256").update(bytes).digest("hex"))
  await writeFile(file, "abc")
  expect(await digest(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

test("file digest refuses missing paths and directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-digest-kind-"))
  await refuses(digest(path.join(root, "absent")))
  await refuses(digest(root), "regular file")
  await mkdir(path.join(root, "nested"))
  await refuses(digest(path.join(root, "nested")), "regular file")
})

test("file digest refuses a file growing during the retained read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-digest-growth-"))
  const file = path.join(root, "image")
  const handle = await open(file, "wx")
  await handle.truncate(64 * 1024 * 1024)
  await handle.close()
  const state = { active: true, writes: 0 }
  const writer = (async () => {
    while (state.active) {
      await appendFile(file, "x")
      state.writes++
    }
  })()
  try {
    await refuses(digest(file), "changed")
    expect(state.writes).toBeGreaterThan(1)
  } finally {
    state.active = false
    await writer
  }
})

test("file digest refuses replacement of the path during a retained read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-digest-replacement-"))
  const file = path.join(root, "image")
  const handle = await open(file, "wx")
  await handle.truncate(64 * 1024 * 1024)
  await handle.close()
  const result = digest(file)
  void result.catch(() => undefined)
  await Bun.sleep(5)
  await rename(file, path.join(root, "original"))
  await writeFile(file, "replacement")
  await refuses(result, "changed")
})
