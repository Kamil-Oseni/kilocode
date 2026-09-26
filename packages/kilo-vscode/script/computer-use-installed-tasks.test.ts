import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score } from "./computer-use-installed-tasks"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-desktop-task-test-"))
  dirs.push(dir)
  const ext = join(dir, "extension")
  const root = join(dir, "task")
  await mkdir(join(ext, "bin"), { recursive: true })
  await writeFile(
    join(ext, "package.json"),
    JSON.stringify({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+test" }),
  )
  await writeFile(join(ext, "bin", "raya-desktop-capture.exe"), "capture bytes")
  await writeFile(join(ext, "bin", "raya-desktop-input.exe"), "input bytes")
  return { dir, ext, root }
}

describe("installed File Explorer task scorer", () => {
  test("refuses to count setup as task completion", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const result = await score(item.root)
    expect(task.manifest.extension.version).toBe("7.4.23-snapshot+test")
    expect(result.correctFinalState).toBe(false)
    expect(result.releaseGateEligible).toBe(false)
    expect(result.missing).toHaveLength(5)
    expect(result.unexpected).toHaveLength(3)
  })

  test("independently checks moved files and their original bytes", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await mkdir(join(item.root, "Notes"))
    await mkdir(join(item.root, "Tables"))
    await rename(join(item.root, "Inbox", "alpha-notes.txt"), join(item.root, "Notes", "alpha-notes.txt"))
    await rename(join(item.root, "Inbox", "beta-notes.txt"), join(item.root, "Notes", "beta-notes.txt"))
    await rename(join(item.root, "Inbox", "quarterly-table.csv"), join(item.root, "Tables", "quarterly-table.csv"))
    expect(await score(item.root)).toMatchObject({ correctFinalState: true, missing: [], unexpected: [], changed: [] })
    await writeFile(join(item.root, "Notes", "alpha-notes.txt"), "altered")
    expect((await score(item.root)).changed).toEqual([join("Notes", "alpha-notes.txt")])
  })

  test("detects an extra file and refuses a modified manifest", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await writeFile(join(item.root, "unexpected.txt"), "extra")
    expect((await score(item.root)).unexpected).toContain("unexpected.txt")
    const path = join(item.root, "task.json")
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    manifest.scenario = "settings-navigation"
    await writeFile(path, JSON.stringify(manifest))
    expect(score(item.root)).rejects.toThrow("Invalid or modified task manifest")
  })

  test("counts an unexpected empty folder as an incorrect final state", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await mkdir(join(item.root, "Unexpected"))
    expect((await score(item.root)).unexpected).toContain("Unexpected/")
  })

  test("refuses to overwrite an existing task directory", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "user.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(item.root, "user.txt"), "utf8")).toBe("keep")
  })
})
