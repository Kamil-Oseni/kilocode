import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { picked } from "../../src/second-brain/dream-sources"

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
  for (const files of [[], [file, file], [path.join(base, "outside.md")], ["relative.md"], Array.from({ length: 9 }, () => file)])
    await expect(picked(project, files, "approved-summary", signal)).rejects.toThrow()
  const alias = path.join(project, "alias.md")
  await link(file, alias)
  await expect(picked(project, [alias], "approved-note", signal)).rejects.toThrow("linked")
  const linked = path.join(base, "junction")
  await symlink(project, linked, process.platform === "win32" ? "junction" : "dir")
  await expect(picked(linked, [path.join(linked, "approved.md")], "approved-note", signal)).rejects.toThrow("ordinary")
})
