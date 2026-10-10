import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { read, secret, text } from "@/kilocode/migration/profile-import-input"

function chunks(bytes: Uint8Array) {
  return (async function* () {
    yield bytes.subarray(0, 9)
    yield bytes.subarray(9)
  })()
}

test("actual import file allocates only observed bytes plus one and refuses oversize/link aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-import-reader-"))
  try {
    const file = path.join(root, "input.json")
    const bytes = Buffer.from('"hello"')
    await fs.writeFile(file, bytes)
    const held = spyOn(Buffer, "alloc")
    try {
      expect(await read(file, 180 * 1024 * 1024)).toEqual(bytes)
      expect(held.mock.calls.filter((args) => args[0] === bytes.length + 1)).toHaveLength(1)
      expect(held.mock.calls.some((args) => args[0] === 180 * 1024 * 1024 + 1)).toBe(false)
    } finally {
      held.mockRestore()
    }
    await expect(read(file, bytes.length - 1)).rejects.toThrow("bounded unique regular file")
    const alias = path.join(root, "alias.json")
    await fs.link(file, alias)
    await expect(read(file, 1024)).rejects.toThrow("bounded unique regular file")
    await fs.unlink(alias)
    await fs.mkdir(path.join(root, "directory"))
    await expect(read(path.join(root, "directory"), 1024)).rejects.toThrow("bounded unique regular file")
    if (process.platform !== "win32") {
      await fs.symlink(file, alias)
      await expect(read(alias, 1024)).rejects.toThrow("bounded unique regular file")
    }
  } finally {
    await fs.rm(root, { recursive: true })
  }
})

test("actual final path observation rejects growth, shrink and same-length edit after ended handle stat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-import-race-"))
  try {
    const file = path.join(root, "mapping.json")
    for (const mode of ["grow", "shrink", "edit", "same", "replace"] as const) {
      await fs.writeFile(file, "original")
      const original = fs.lstat
      let calls = 0
      // Transparent instrumentation delegates every stat to the actual filesystem.
      // It mutates the real owned file immediately before the final path lstat.
      const observe = (async (selected: Parameters<typeof fs.lstat>[0], opts?: Parameters<typeof fs.lstat>[1]) => {
        if (selected === file && ++calls === 2) {
          if (mode === "grow") await fs.appendFile(file, "extra")
          if (mode === "shrink") await fs.truncate(file, 1)
          if (mode === "edit") await fs.writeFile(file, "modified")
          if (mode === "same") await fs.writeFile(file, "original")
          if (mode === "replace") {
            await fs.rename(file, path.join(root, "retired.json"))
            await fs.writeFile(file, "original")
          }
          await fs.utimes(file, new Date(1000), new Date(2000))
        }
        return original(selected, opts)
      }) as typeof fs.lstat
      const held = spyOn(fs, "lstat").mockImplementation(observe)
      try {
        await expect(read(file, 1024)).rejects.toThrow("changed during reading")
        expect(calls).toBe(2)
      } finally {
        held.mockRestore()
      }
    }
  } finally {
    await fs.rm(root, { recursive: true })
  }
})

test("archive and mapping decoding refuses invalid UTF8 from actual bounded files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-import-utf8-"))
  try {
    for (const name of ["archive", "mapping"]) {
      const file = path.join(root, `${name}.json`)
      await fs.writeFile(file, Buffer.from([0x22, 0xc0, 0xaf, 0x22]))
      const bytes = await read(file, 1024)
      expect(() => text(bytes)).toThrow()
    }
    expect(text(Buffer.from('"café 日本語 😀"'))).toBe('"café 日本語 😀"')
    expect(text(Buffer.from([0xef, 0xbb, 0xbf, 0x31]))).toBe("\ufeff1")
  } finally {
    await fs.rm(root, { recursive: true })
  }
})

test("production private secret reader enforces strict UTF8, JSON and original byte caps", async () => {
  const valid = Buffer.from(JSON.stringify({ password: "日本語-secret-😀" }))
  expect(await secret(chunks(valid))).toBe("日本語-secret-😀")
  const invalid = Buffer.concat([Buffer.from('{"password":"12345678901'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')])
  await expect(secret(chunks(invalid))).rejects.toThrow()
  await expect(secret(chunks(Buffer.from('{"password":')))).rejects.toThrow()
  await expect(secret(chunks(Buffer.from(JSON.stringify({ password: "short" }))))).rejects.toThrow()
  await expect(secret(chunks(Buffer.from(" ".repeat(4097))))).rejects.toThrow("stdin exceeded bound")
})
