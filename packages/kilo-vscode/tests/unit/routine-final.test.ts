import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, realpath, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { pin, choose } from "../../src/kilo-provider/routine-final"
import { Final, Output } from "../../src/shared/routine-output"

test("final-answer approval pins exact real UTF-8 bytes including BOM, CRLF, whitespace and empty files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-final-"))
  try {
    const path = join(dir, "answer.txt")
    for (const data of [Buffer.from("\ufeffHello\r\n  \n"), Buffer.alloc(0), Buffer.alloc(8192, 32)]) {
      await writeFile(path, data)
      const final = await pin(path)
      expect(final).toEqual({
        kind: "file",
        path: await realpath(path),
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      })
      expect(Buffer.from(await Bun.file(path).bytes()).equals(data)).toBe(true)
    }
    await writeFile(path, Buffer.from([0xc3, 0x28]))
    await expect(pin(path)).rejects.toThrow()
    await writeFile(path, Buffer.alloc(8193))
    await expect(pin(path)).rejects.toThrow("8192")
    await mkdir(join(dir, "folder"))
    await expect(pin(join(dir, "folder"))).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("file-choice replies correlate to one explicit request and stale ownership cannot read or publish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-final-"))
  const messages: unknown[] = []
  try {
    const path = join(dir, "answer.txt")
    await writeFile(path, "exact")
    await choose({ requestID: "owner", current: () => true, pick: async () => path, post: (msg) => messages.push(msg) })
    expect(messages).toEqual([
      { type: "routineFinalPicked", requestID: "owner", final: await pin(path), cancelled: false },
    ])
    await choose({
      requestID: "cancel",
      current: () => true,
      pick: async () => undefined,
      post: (msg) => messages.push(msg),
    })
    expect(messages[1]).toEqual({ type: "routineFinalPicked", requestID: "cancel", final: undefined, cancelled: true })
    let current = true
    await choose({
      requestID: "stale",
      current: () => current,
      pick: async () => {
        current = false
        return join(dir, "missing")
      },
      post: (msg) => messages.push(msg),
    })
    expect(messages).toHaveLength(2)
    await choose({
      requestID: "invalid",
      current: () => true,
      pick: async () => join(dir, "missing"),
      post: (msg) => messages.push(msg),
    })
    expect(messages[2]).toMatchObject({ type: "routineFinalPicked", requestID: "invalid", error: expect.any(String) })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("final contracts are strict bounded absolute-file pins and remain optional on legacy outputs", () => {
  const final = { kind: "file", path: "C:\\approved\\answer.txt", bytes: 0, sha256: "a".repeat(64) }
  const output = {
    destination: "conversation",
    description: "Exact answer",
    criteria: [{ id: "exact", description: "Match bytes", verification: "Compare the approved file" }],
  }
  expect(Output.safeParse(output).success).toBe(true)
  expect(Output.safeParse({ ...output, final }).success).toBe(true)
  for (const invalid of [
    { ...final, path: "relative.txt" },
    { ...final, path: "/bad\npath" },
    { ...final, bytes: 8193 },
    { ...final, bytes: 0.5 },
    { ...final, bytes: -1 },
    { ...final, sha256: "A".repeat(64) },
    { ...final, contents: "unapproved" },
    { ...final, kind: "text" },
  ]) {
    expect(Final.safeParse(invalid).success).toBe(false)
  }
})
