import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare, score } from "./computer-use-comparison-task"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "raya-comparison-task-test-"))
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

async function complete(root: string) {
  await copyFile(join(root, "Baseline", "accounts.csv"), join(root, "Working", "accounts.csv"))
  const baseline = await readFile(join(root, "Baseline", "accounts.csv"), "utf8")
  const seed = Number(/^A01,(\d+)$/m.exec(baseline)?.[1])
  await writeFile(
    join(root, "Working", "comparison.csv"),
    `id,baseline,current,status\nA01,${seed},${seed},same\nA02,${seed + 2},${seed + 3},changed\nA03,${seed + 4},,removed\nA04,${seed + 6},${seed + 6},same\nA05,,${seed + 8},added\n`,
  )
}

describe("installed multi-window comparison task scorer", () => {
  test("preparation is not completion and cannot qualify the release gate", async () => {
    const item = await fixture()
    const task = await prepare(item.root, item.ext)
    const result = await score(item.root)
    expect(task.manifest.scenario).toBe("multi-window-comparison")
    expect(task.manifest.extension.version).toBe("7.4.23-snapshot+test")
    expect(result.correctFinalState).toBe(false)
    expect(result.missing).toEqual([join("Working", "accounts.csv"), join("Working", "comparison.csv")])
    expect(result.releaseGateEligible).toBe(false)
  })

  test("checks both the copied bytes and the independently computed comparison", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await complete(item.root)
    expect(await score(item.root)).toMatchObject({ correctFinalState: true, missing: [], unexpected: [], changed: [] })
    await writeFile(join(item.root, "Working", "accounts.csv"), "wrong copy")
    expect((await score(item.root)).changed).toEqual([join("Working", "accounts.csv")])
  })

  test("rejects wrong comparison values even when all expected files exist", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await complete(item.root)
    const path = join(item.root, "Working", "comparison.csv")
    await writeFile(path, (await readFile(path, "utf8")).replace("changed", "same"))
    expect((await score(item.root)).changed).toEqual([join("Working", "comparison.csv")])
  })

  test("detects changed source data and unexpected task files", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await complete(item.root)
    await writeFile(join(item.root, "Baseline", "accounts.csv"), "id,value\nA01,1\n")
    await writeFile(join(item.root, "extra.txt"), "unintended")
    const result = await score(item.root)
    expect(result.correctFinalState).toBe(false)
    expect(result.unexpected).toContain("extra.txt")
    expect(result.changed).toContain(join("Baseline", "accounts.csv"))
  })

  test("reports a missing source instead of treating it as a successful comparison", async () => {
    const item = await fixture()
    await prepare(item.root, item.ext)
    await rm(join(item.root, "Baseline", "accounts.csv"))
    const result = await score(item.root)
    expect(result.correctFinalState).toBe(false)
    expect(result.missing).toContain(join("Baseline", "accounts.csv"))
  })

  test("refuses a modified manifest and an occupied task directory", async () => {
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
    expect(score(item.root)).rejects.toThrow("Invalid or modified task manifest")
  })
})
