import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score } from "./computer-use-drag-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-drag-task-test-"))
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
  return { ext, root }
}

describe("installed drag-and-drop task scorer", () => {
  test("randomizes local paths, and preparation is not a completed move", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const result = await score(item.root)
    expect(task.manifest.scenario).toBe("drag-and-drop")
    expect(task.manifest.extension.version).toBe("7.4.23-snapshot+test")
    expect(task.manifest.source).toMatch(/^Source-[\da-f]{8}$/)
    expect(task.manifest.target).toMatch(/^Target-[\da-f]{8}$/)
    expect(result.correctFinalState).toBe(false)
    expect(result.missing).toContain(join(task.manifest.target, task.manifest.file))
    expect(result.unexpected).toContain(join(task.manifest.source, task.manifest.file))
    expect(result.observableExtraEffects).toBe(0)
    expect(result.replayEvidence).toBe(false)
    expect(result.releaseGateEligible).toBe(false)
  })

  test("accepts exactly one intact move and no other filesystem change", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    await rename(
      join(item.root, task.manifest.source, task.manifest.file),
      join(item.root, task.manifest.target, task.manifest.file),
    )
    expect(await score(item.root)).toMatchObject({
      correctFinalState: true,
      missing: [],
      unexpected: [],
      changed: [],
      duplicates: [],
      replayEvidence: false,
      releaseGateEligible: false,
    })
  })

  test("rejects a copy that leaves the source behind", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    await copyFile(
      join(item.root, task.manifest.source, task.manifest.file),
      join(item.root, task.manifest.target, task.manifest.file),
    )
    const result = await score(item.root)
    expect(result.correctFinalState).toBe(false)
    expect(result.unexpected).toContain(join(task.manifest.source, task.manifest.file))
    expect(result.replayEvidence).toBe(false)
  })

  test("detects a wrong destination and an extra copy as observable unintended or replay effects", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const source = join(item.root, task.manifest.source, task.manifest.file)
    const wrong = join(item.root, task.manifest.other, task.manifest.file)
    await rename(source, wrong)
    const misplaced = await score(item.root)
    expect(misplaced.correctFinalState).toBe(false)
    expect(misplaced.missing).toContain(join(task.manifest.target, task.manifest.file))
    expect(misplaced.unexpected).toContain(join(task.manifest.other, task.manifest.file))
    expect(misplaced.observableExtraEffects).toBeGreaterThan(0)
    await copyFile(wrong, join(item.root, task.manifest.target, task.manifest.file))
    const duplicate = await score(item.root)
    expect(duplicate.duplicates).toEqual([join(task.manifest.other, task.manifest.file)])
    expect(duplicate.replayEvidence).toBe(true)
  })

  test("detects corrupted payload, changed decoy, and new files", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    await rename(
      join(item.root, task.manifest.source, task.manifest.file),
      join(item.root, task.manifest.target, task.manifest.file),
    )
    await writeFile(join(item.root, task.manifest.target, task.manifest.file), "wrong")
    await writeFile(join(item.root, task.manifest.other, "keep.txt"), "changed")
    await writeFile(join(item.root, "extra.txt"), "unintended")
    const result = await score(item.root)
    expect(result.correctFinalState).toBe(false)
    expect(result.changed).toContain(join(task.manifest.target, task.manifest.file))
    expect(result.changed).toContain(join(task.manifest.other, "keep.txt"))
    expect(result.unexpected).toContain("extra.txt")
    expect(result.observableExtraEffects).toBe(3)
  })

  test("refuses an occupied directory and a modified manifest", async () => {
    const item = await fixture()
    await mkdir(item.root)
    await writeFile(join(item.root, "keep.txt"), "keep")
    expect(prepare(item.root, item.ext)).rejects.toThrow("empty disposable task directory")
    expect(await readFile(join(item.root, "keep.txt"), "utf8")).toBe("keep")
    await rm(item.root, { recursive: true })
    await prepare(item.root, item.ext)
    const path = join(item.root, "task.json")
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    manifest.scenario = "file-explorer-organization"
    await writeFile(path, JSON.stringify(manifest))
    expect(score(item.root)).rejects.toThrow("Invalid or modified drag task manifest")
  })
})
