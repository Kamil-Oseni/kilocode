import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

test("Dream slots persist scope and retain identities across explicit note moves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dream-slots-"))
  const project = path.join(root, "project")
  const signal = new AbortController().signal
  const first = await MemoryFiles.dream.bind(root, project, [{ key: "voice", path: "Preferences/voice.md" }], signal)
  expect(first.scope).toMatch(/^[a-f0-9-]{36}$/)
  const saved = JSON.parse(await readFile(path.join(root, "dream.json"), "utf8"))
  expect(saved.scope).toBe(first.scope)
  const moved = await MemoryFiles.dream.bind(root, project, [{ key: "voice", path: "Preferences/speech.md" }], signal)
  expect(moved.scope).toBe(first.scope)
  expect((await MemoryFiles.dream.list(root, project)).slots).toEqual(moved.slots)
  const before = await readFile(path.join(root, "dream.json"), "utf8")
  await expect(
    MemoryFiles.dream.bind(root, project, [{ key: "other", path: "Preferences/Speech.md" }], signal),
  ).rejects.toThrow("another target slot")
  await expect(
    MemoryFiles.dream.bind(root, project, [{ key: "voice", path: "../escape.md" }], signal),
  ).rejects.toThrow()
  await expect(
    MemoryFiles.dream.bind(root, project, [{ key: "voice", path: "secrets/token.md" }], signal),
  ).rejects.toThrow()
  await expect(MemoryFiles.dream.bind(root, path.join(root, "foreign"), moved.slots, signal)).rejects.toThrow(
    "another project",
  )
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  const controller = new AbortController()
  controller.abort()
  await expect(MemoryFiles.dream.bind(root, project, moved.slots, controller.signal)).rejects.toThrow()
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  await MemoryFiles.dream.begin(root, project, {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    model: "local/test",
    sources: [{ path: "approved.md", sha256: "a".repeat(64) }],
    timeout: 10000,
    budget: { input: 1000, output: 1000 },
  })
  await expect(MemoryFiles.dream.bind(root, project, moved.slots, signal)).rejects.toThrow("original Dream work")
})
