import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { picked, targets } from "../../src/second-brain/dream-sources"

test("picked source revisions use actual bounded files and refuse foreign or linked input", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "raya-dream-picks-"))
  const project = path.join(base, "project")
  await mkdir(project)
  const file = path.join(project, "approved.md")
  const text = "Approved synthetic summary."
  await writeFile(file, text)
  const signal = new AbortController().signal
  expect(await picked(project, [file], "approved-summary", signal)).toEqual([
    { path: "approved.md", sha256: createHash("sha256").update(text).digest("hex"), kind: "approved-summary" },
  ])
  for (const files of [
    [],
    [file, file],
    [path.join(base, "outside.md")],
    ["relative.md"],
    Array.from({ length: 9 }, () => file),
  ])
    await expect(picked(project, files, "approved-summary", signal)).rejects.toThrow()
  const alias = path.join(project, "alias.md")
  await link(file, alias)
  await expect(picked(project, [alias], "approved-note", signal)).rejects.toThrow("linked")
  const linked = path.join(base, "junction")
  await symlink(project, linked, process.platform === "win32" ? "junction" : "dir")
  await expect(picked(linked, [path.join(linked, "approved.md")], "approved-note", signal)).rejects.toThrow("ordinary")
})

test("native target selections bind stable slots with actual existing and absent baselines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-targets-"))
  const project = path.join(root, "project")
  const file = path.join(root, "voice.md")
  await writeFile(file, "Approved calm voice.")
  const signal = new AbortController().signal
  const authorize = () => signal.throwIfAborted()
  const selected = await targets(
    root,
    project,
    [
      { key: "voice", path: file },
      { key: "walk", path: path.join(root, "walk.md") },
    ],
    authorize,
    signal,
  )
  expect(selected.targets).toEqual([
    { key: "voice", path: "voice.md", expected: createHash("sha256").update("Approved calm voice.").digest("hex") },
    { key: "walk", path: "walk.md", expected: null },
  ])
  await expect(readFile(path.join(root, "walk.md"))).rejects.toThrow()
  const before = await readFile(path.join(root, "dream.json"), "utf8")
  await expect(
    targets(root, project, [{ key: "foreign", path: path.join(root, "..", "foreign.md") }], authorize, signal),
  ).rejects.toThrow()
  await expect(
    targets(root, project, [{ key: "invalid", path: path.join(root, "private", "hidden.md") }], authorize, signal),
  ).rejects.toThrow()
  await expect(targets(root, project, [{ key: "new", path: file }], authorize, signal)).rejects.toThrow(
    "another target slot",
  )
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  let reads = 0
  await expect(
    targets(
      root,
      project,
      [{ key: "voice", path: file }],
      () => {
        if (++reads === 3) throw new Error("Authority revoked")
      },
      signal,
    ),
  ).rejects.toThrow("revoked")
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  const moved = await targets(root, project, [{ key: "voice", path: path.join(root, "speech.md") }], authorize, signal)
  expect(moved.scope).toBe(selected.scope)
  expect(moved.targets).toEqual([{ key: "voice", path: "speech.md", expected: null }])
  expect(await readFile(file, "utf8")).toBe("Approved calm voice.")
})
