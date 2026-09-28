import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { read, text, drained, exited } from "../../src/kilocode/pty/receipts"

test("native PTY bounded receipts reject excess bytes, encoding and substituted proof", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-pty-receipts-"))
  const file = path.join(dir, "receipt")
  const token = randomUUID()
  try {
    expect(await read(file)).toBeUndefined()
    const value = { version: 2, token, proof: "windows-job", empty: true }
    await writeFile(file, JSON.stringify(value))
    expect(drained(await read(file), token)).toBe(true)
    expect(drained(await read(file), randomUUID())).toBe(false)
    for (const row of [
      { ...value, version: 1 },
      { ...value, proof: "scan" },
      { ...value, empty: false },
      { ...value, extra: true },
    ]) {
      await writeFile(file, JSON.stringify(row))
      expect(drained(await read(file), token)).toBe(false)
    }
    await writeFile(file, Buffer.alloc(1024 * 1024, 32))
    await expect(read(file)).rejects.toThrow("exceeded bound")
    await writeFile(file, Buffer.from([0xff, 0xfe]))
    await expect(read(file)).rejects.toThrow()
    await writeFile(file, "secret-fragment-invalid-json")
    await expect(read(file)).rejects.toThrow("Native PTY receipt malformed")
    await writeFile(file, "changed")
    expect(await text(file)).toBe("changed")
    await writeFile(file, "stop")
    expect(await text(file)).toBe("stop")
    const identity = { pid: 11, birth: "22", helper: 33, helperBirth: "44" }
    const exit = {
      version: 1,
      token,
      proof: "windows-job",
      pid: identity.pid,
      birth: identity.birth,
      state: "exited",
      exitCode: 7,
      outcome: "confirmed",
    }
    await writeFile(file, JSON.stringify(exit))
    expect(exited(await read(file), token, identity)).toEqual({ exitCode: 7, outcome: "confirmed" })
    for (const row of [
      { ...exit, token: randomUUID() },
      { ...exit, pid: 99 },
      { ...exit, birth: "99" },
      { ...exit, exitCode: -1 },
      { ...exit, outcome: "unknown" },
      { ...exit, extra: true },
    ]) {
      await writeFile(file, JSON.stringify(row))
      expect(exited(await read(file), token, identity)).toEqual({ outcome: "unknown" })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
