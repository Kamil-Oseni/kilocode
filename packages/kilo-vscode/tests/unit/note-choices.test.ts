import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { choices } from "../../src/second-brain/note-choices"

const fixture = async () => realpath(await mkdtemp(path.join(os.tmpdir(), "raya-note-choices-")))

test("note choices lists eligible metadata and excludes restricted names at every depth", async () => {
  const root = await fixture()
  for (const name of ["Projects", "System", "Archive", "Projects/Private"])
    await mkdir(path.join(root, name), { recursive: true })
  for (const name of [
    "Setup.md",
    "Projects/Work.MD",
    "Health.md",
    "Projects/Medical.md",
    "System/Policy.md",
    "Archive/Old.md",
    "Projects/Private/Note.md",
    "readme.txt",
  ])
    await writeFile(path.join(root, name), "Synthetic file")
  expect(await choices(root)).toEqual(["Projects/Work.MD", "Setup.md"])
})

test("note choices never follows junctions or offers multiply linked files", async () => {
  const root = await fixture()
  const outside = await fixture()
  await writeFile(path.join(outside, "Outside.md"), "Synthetic excluded note")
  await symlink(outside, path.join(root, "Redirect"), "junction")
  await writeFile(path.join(root, "Linked.md"), "Synthetic linked note")
  await link(path.join(root, "Linked.md"), path.join(root, "Alias.md"))
  await writeFile(path.join(root, "Allowed.md"), "Synthetic eligible note")
  expect(await choices(root)).toEqual(["Allowed.md"])
  await expect(choices(path.join(root, "Redirect"))).rejects.toThrow("ordinary")
})

test("note choices refuses more sources than the native review can admit", async () => {
  const root = await fixture()
  await Promise.all(
    Array.from({ length: 129 }, (_, index) => writeFile(path.join(root, String(index) + ".md"), "Synthetic note")),
  )
  await expect(choices(root)).rejects.toThrow("128")
})
